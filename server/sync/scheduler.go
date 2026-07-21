package sync

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/yuweinfo/xcontrol/model"
)

// Scheduler fires version creation from three sources:
//   - scheduled: every X hours and/or daily at HH:MM
//   - change:    business-data mutations, debounced
//   - shutdown:  handled synchronously by Manager.ShutdownBackup (no loop)
type Scheduler struct {
	m       *Manager
	mu      sync.Mutex
	timer   *time.Timer
	debounce *time.Timer
	reload  chan struct{}
	stop    chan struct{}
	stopped sync.Once
}

func newScheduler(m *Manager) *Scheduler {
	return &Scheduler{
		m:      m,
		reload: make(chan struct{}, 1),
		stop:   make(chan struct{}),
	}
}

// Reload reschedules the timer after settings change.
func (s *Scheduler) Reload() {
	select {
	case s.reload <- struct{}{}:
	default:
	}
}

func (s *Scheduler) Stop() {
	s.stopped.Do(func() { close(s.stop) })
}

func (s *Scheduler) Run(ctx context.Context) {
	go func() {
		s.armTimer()
		for {
			select {
			case <-s.stop:
				return
			case <-ctx.Done():
				return
			case <-s.reload:
				s.armTimer()
			case <-s.timerChan():
				s.fire(model.SyncOriginScheduled)
				s.armTimer()
			case <-s.m.changeCh:
				s.armDebounce()
			case <-s.debounceChan():
				s.fire(model.SyncOriginChange)
			}
		}
	}()
}

// fire creates a version if the corresponding feature is enabled.
func (s *Scheduler) fire(origin string) {
	settings, err := s.m.settings()
	if err != nil {
		return
	}
	switch origin {
	case model.SyncOriginScheduled:
		if !settings.ScheduledEnabled {
			return
		}
	case model.SyncOriginChange:
		if !settings.AutoBackupEnabled {
			return
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	v, err := s.m.CreateVersion(ctx, origin)
	if err != nil {
		if err != ErrPasswordRequired {
			slog.Warn("scheduled sync backup failed", "origin", origin, "error", err)
			s.m.versions.LogEvent("", "backup", 0, false, err.Error())
		}
		return
	}
	if v != nil {
		slog.Info("sync version created", "version", v.Version, "origin", origin, "size", v.Size)
	}
	// Auto bidirectional sync after each trigger.
	if settings.SyncMode == "auto" {
		s.m.SyncAll(ctx)
	}
}

// ── timer plumbing ──────────────────────────────────────────────────────────

// nextScheduledDelay computes the wait until the next scheduled backup:
// the earlier of "interval from now" and "next daily HH:MM". Returns 0 when
// scheduling is disabled.
func nextScheduledDelay(st *model.SyncSettings, now time.Time) time.Duration {
	if !st.ScheduledEnabled {
		return 0
	}
	var delays []time.Duration
	if st.ScheduledIntervalHrs > 0 {
		delays = append(delays, time.Duration(st.ScheduledIntervalHrs)*time.Hour)
	}
	if st.ScheduledDailyTime != "" {
		if d, ok := dailyDelay(st.ScheduledDailyTime, now); ok {
			delays = append(delays, d)
		}
	}
	if len(delays) == 0 {
		return 0
	}
	min := delays[0]
	for _, d := range delays[1:] {
		if d < min {
			min = d
		}
	}
	return min
}

// dailyDelay returns the duration until the next occurrence of HH:MM local time.
func dailyDelay(hhmm string, now time.Time) (time.Duration, bool) {
	t, err := time.ParseInLocation("15:04", hhmm, time.Local)
	if err != nil {
		return 0, false
	}
	next := time.Date(now.Year(), now.Month(), now.Day(), t.Hour(), t.Minute(), 0, 0, time.Local)
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next.Sub(now), true
}

func (s *Scheduler) armTimer() {
	s.mu.Lock()
	defer s.mu.Unlock()
	settings, err := s.m.settings()
	if err != nil {
		return
	}
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if d := nextScheduledDelay(settings, time.Now()); d > 0 {
		s.timer = time.NewTimer(d)
		slog.Debug("sync scheduled backup armed", "in", d)
	}
}

func (s *Scheduler) armDebounce() {
	s.mu.Lock()
	defer s.mu.Unlock()
	settings, err := s.m.settings()
	if err != nil {
		return
	}
	window := time.Duration(settings.ChangeDebounceSeconds) * time.Second
	if window <= 0 {
		window = 30 * time.Second
	}
	if s.debounce == nil {
		s.debounce = time.NewTimer(window)
	} else {
		s.debounce.Reset(window)
	}
}

func (s *Scheduler) timerChan() <-chan time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer == nil {
		return nil
	}
	return s.timer.C
}

func (s *Scheduler) debounceChan() <-chan time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.debounce == nil {
		return nil
	}
	return s.debounce.C
}
