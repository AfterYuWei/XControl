package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/yuweinfo/xcontrol/connpool"
	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/fileutil"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/protocol"
	"github.com/yuweinfo/xcontrol/store"
)

// ServerDetailSession holds a pooled connection entry used for file browsing
// (via SFTP backend) and command execution (via SSH exec).
type ServerDetailSession struct {
	ID        string
	ProfileID string
	Entry     *connpool.Entry // shared connection from pool
	Status    string          // connecting | connected | disconnected
	Error     string
	HomeDir   string // User's home directory
	CreatedAt time.Time

	cancel   context.CancelFunc
	done     chan struct{}
	doneOnce sync.Once

	sampleMu   sync.Mutex
	lastSample *rawMetricsSnapshot
}

func (s *ServerDetailSession) closeDone() {
	s.doneOnce.Do(func() {
		close(s.done)
	})
}

type cpuCounters struct {
	total uint64
	idle  uint64
}

type netCounters struct {
	rx uint64
	tx uint64
}

type rawMetricsSnapshot struct {
	takenAt   time.Time
	cpu       cpuCounters
	cpuDetail []cpuCounters
	memUsed   int64
	memTotal  int64
	memDetail []model.ProcMem
	diskUsed  int64
	diskTotal int64
	netDetail map[string]netCounters
}

// ServerDetailHandler manages "management connections" — one per server —
// that provide file browsing (SFTP) and system metrics (SSH exec).
// All connections go through the connection pool; no independent SSH
// connections are created.
type ServerDetailHandler struct {
	sessions  map[string]*ServerDetailSession
	mu        sync.RWMutex
	profiles  store.ProfileStore
	vault     store.VaultStore
	encryptor *crypto.Encryptor
	pool      *connpool.Pool
}

func NewServerDetailHandler(ps store.ProfileStore, vs store.VaultStore, enc *crypto.Encryptor, pool *connpool.Pool) *ServerDetailHandler {
	return &ServerDetailHandler{
		sessions:  make(map[string]*ServerDetailSession),
		profiles:  ps,
		vault:     vs,
		encryptor: enc,
		pool:      pool,
	}
}

// CreateSession acquires a pooled connection for a server (sshRef + sftpRef).
// The connection is established synchronously so the response already carries
// status "connected" — the frontend can immediately call /info and /files.
func (h *ServerDetailHandler) CreateSession(w http.ResponseWriter, r *http.Request) {
	var req model.ServerSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.ProfileID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "profile_id is required")
		return
	}

	// Resolve profile and credentials first
	profile, err := h.profiles.Get(req.ProfileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}

	var password, privKey, passphrase, cert string
	cred, err := resolveProfileCredential(profile, h.vault, h.encryptor)
	if err != nil {
		slog.Warn("server detail: failed to resolve credential", "error", err)
	} else {
		password = cred.Password
		privKey = cred.PrivKey
		passphrase = cred.Passphrase
		cert = cred.Cert
	}

	opts := protocol.DriverOpts{
		Host:               profile.Host,
		Port:               profile.Port,
		Username:           profile.Username,
		Password:           password,
		PrivKey:            privKey,
		Passphrase:         passphrase,
		Cert:               cert,
		HostKeyFingerprint: profileHostKeyFingerprint(profile.Options),
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Acquire from connection pool — blocks until connected (or timeout)
	entry, err := h.pool.Acquire(ctx, opts)
	if err != nil {
		writeError(w, http.StatusBadGateway, "CONNECT_FAILED", "连接失败: "+err.Error())
		return
	}

	sessionID := uuid.New().String()
	homeDir := h.resolveHomeDir(profile.Username, entry)

	session := &ServerDetailSession{
		ID:        sessionID,
		ProfileID: req.ProfileID,
		Entry:     entry,
		Status:    "connected",
		HomeDir:   homeDir,
		CreatedAt: time.Now(),
		cancel:    func() {},
		done:      make(chan struct{}),
	}

	if entry.Exec != nil {
		if snapshot, snapshotErr := h.collectRawMetrics(entry); snapshotErr == nil {
			session.lastSample = snapshot
		} else {
			slog.Debug("server detail: initial metrics snapshot failed", "error", snapshotErr)
		}
	}

	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	if lc, ok := entry.Driver.(protocol.ConnectionLifecycle); ok {
		lc.OnDead(func(reason string) {
			h.mu.Lock()
			current, exists := h.sessions[sessionID]
			if exists {
				current.Status = "disconnected"
				current.Error = "management connection lost: " + reason
				current.Entry = nil
			}
			h.mu.Unlock()
			if exists {
				session.closeDone()
			}
		})
	}

	writeJSON(w, http.StatusCreated, model.ServerSessionResponse{
		SessionID: sessionID,
		Status:    "connected",
		HomeDir:   homeDir,
	})
}

// CloseSession releases the pooled connection refs.
func (h *ServerDetailHandler) CloseSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h.mu.Lock()
	session, ok := h.sessions[id]
	if !ok {
		h.mu.Unlock()
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}
	delete(h.sessions, id)
	h.mu.Unlock()

	session.closeDone()
	if session.cancel != nil {
		session.cancel()
	}
	if session.Entry != nil {
		session.Entry.ReleaseSSH()
		session.Entry.ReleaseSFTP()
		session.Entry = nil
	}

	w.WriteHeader(http.StatusNoContent)
}

// GetInfo returns static server information (hostname, OS, uptime, etc.).
func (h *ServerDetailHandler) GetInfo(w http.ResponseWriter, r *http.Request) {
	session, entry, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	if entry.Exec == nil {
		writeError(w, http.StatusNotImplemented, "NOT_SUPPORTED", "driver does not support command execution")
		return
	}

	cmd := `echo "===HOSTNAME===" && hostname -f 2>/dev/null || hostname && ` +
		`echo "===OS===" && (cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -o 2>/dev/null || echo "Unknown") && ` +
		`echo "===KERNEL===" && uname -r && ` +
		`echo "===ARCH===" && uname -m && ` +
		`echo "===UPTIME===" && (uptime -p 2>/dev/null || uptime) && ` +
		`echo "===LOAD===" && (cat /proc/loadavg 2>/dev/null || uptime | awk -F'load average:' '{print $2}') && ` +
		`echo "===CPUS===" && (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)`

	stdout, _, exitCode, err := entry.Exec.Exec(cmd)
	if err != nil && exitCode != 0 {
		writeError(w, http.StatusInternalServerError, "EXEC_FAILED", fmt.Sprintf("command failed: %v", err))
		return
	}

	info := parseServerInfo(string(stdout))
	_ = session // used for context
	writeJSON(w, http.StatusOK, info)
}

// ListFiles returns the contents of a directory via the pooled SFTP backend.
func (h *ServerDetailHandler) ListFiles(w http.ResponseWriter, r *http.Request) {
	session, entry, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	if entry.Backend == nil {
		writeError(w, http.StatusNotImplemented, "NOT_SUPPORTED", "SFTP not available")
		return
	}

	p := r.URL.Query().Get("path")
	if p == "" {
		p = "/"
	}

	// show_hidden controls whether hidden files (starting with .) are included.
	// Default is false (hidden files are filtered out).
	showHidden := r.URL.Query().Get("show_hidden") == "true"

	// Use the standard FileBackend.List() — unified error handling and formatting
	ctx := r.Context()
	entries, err := entry.Backend.List(ctx, p)
	if err != nil {
		// Use the same error mapping as SftpHandler
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "not exist") {
			writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		} else if strings.Contains(err.Error(), "permission") {
			writeError(w, http.StatusForbidden, "PERMISSION_DENIED", err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "LIST_FAILED", err.Error())
		}
		return
	}

	// Convert to SftpEntry format (unified with SftpHandler)
	result := make([]model.SftpEntry, 0, len(entries))
	for _, e := range entries {
		// Filter out hidden files unless explicitly requested
		if !showHidden && len(e.Name) > 0 && e.Name[0] == '.' {
			continue
		}
		result = append(result, toSftpEntry(e))
	}
	_ = session
	writeJSON(w, http.StatusOK, model.SftpListResponse{
		Path:    p,
		Entries: result,
	})
}

// Mkdir creates a new directory.
func (h *ServerDetailHandler) Mkdir(w http.ResponseWriter, r *http.Request) {
	session, entry, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	if entry.Backend == nil {
		writeError(w, http.StatusNotImplemented, "NOT_SUPPORTED", "SFTP not available")
		return
	}

	var req model.SftpMkdirRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "path is required")
		return
	}

	ctx := r.Context()
	if err := entry.Backend.Mkdir(ctx, req.Path); err != nil {
		if strings.Contains(err.Error(), "permission") {
			writeError(w, http.StatusForbidden, "PERMISSION_DENIED", err.Error())
		} else if strings.Contains(err.Error(), "exist") {
			writeError(w, http.StatusConflict, "ALREADY_EXISTS", err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "MKDIR_FAILED", err.Error())
		}
		return
	}

	_ = session
	writeJSON(w, http.StatusOK, model.SftpEntry{
		Path:  req.Path,
		IsDir: true,
	})
}

// Rename renames or moves a file or directory.
func (h *ServerDetailHandler) Rename(w http.ResponseWriter, r *http.Request) {
	session, entry, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	if entry.Backend == nil {
		writeError(w, http.StatusNotImplemented, "NOT_SUPPORTED", "SFTP not available")
		return
	}

	var req model.SftpRenameRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if req.OldPath == "" || req.NewPath == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "old_path and new_path are required")
		return
	}

	ctx := r.Context()
	if err := entry.Backend.Rename(ctx, req.OldPath, req.NewPath); err != nil {
		if strings.Contains(err.Error(), "permission") {
			writeError(w, http.StatusForbidden, "PERMISSION_DENIED", err.Error())
		} else if strings.Contains(err.Error(), "not found") {
			writeError(w, http.StatusNotFound, "NOT_FOUND", err.Error())
		} else {
			writeError(w, http.StatusInternalServerError, "RENAME_FAILED", err.Error())
		}
		return
	}

	_ = session
	writeJSON(w, http.StatusOK, model.SftpEntry{
		Path: req.NewPath,
	})
}

// Delete deletes files or directories.
func (h *ServerDetailHandler) Delete(w http.ResponseWriter, r *http.Request) {
	session, entry, ok := h.resolveSession(w, r)
	if !ok {
		return
	}
	if entry.Backend == nil {
		writeError(w, http.StatusNotImplemented, "NOT_SUPPORTED", "SFTP not available")
		return
	}

	var req model.SftpDeleteRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if len(req.Paths) == 0 {
		writeError(w, http.StatusBadRequest, "VALIDATION", "paths is required")
		return
	}

	ctx := r.Context()
	deleted := 0
	failed := 0
	for _, p := range req.Paths {
		if err := entry.Backend.Remove(ctx, p); err != nil {
			failed++
		} else {
			deleted++
		}
	}

	_ = session
	writeJSON(w, http.StatusOK, model.SftpDeleteResponse{
		Deleted: deleted,
		Failed:  failed,
	})
}

// HandleWS handles WebSocket connections for real-time metrics.
func (h *ServerDetailHandler) HandleWS(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "session_id is required")
		return
	}

	h.mu.RLock()
	session, ok := h.sessions[sessionID]
	h.mu.RUnlock()
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return
	}
	if session.Status != "connected" || session.Entry == nil {
		writeError(w, http.StatusConflict, "NOT_CONNECTED", "session is "+session.Status)
		return
	}

	wsConn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("server detail ws accept failed", "error", err)
		return
	}
	defer wsConn.Close(websocket.StatusNormalClosure, "")

	// Use Background context — r.Context() is canceled when the HTTP handler
	// returns, but we need the WebSocket to outlive the HTTP request lifecycle.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	entry := session.Entry

	// Send server info immediately on connection
	if entry.Exec != nil {
		info := h.collectServerInfo(entry)
		writeWSJSON(ctx, wsConn, map[string]any{
			"type": model.MsgServerInfo,
			"data": info,
		})
	}

	// Send first metrics snapshot immediately (don't wait for first tick)
	if entry.Exec != nil {
		metrics := h.collectMetrics(session, entry)
		metrics.Timestamp = time.Now().UnixMilli()
		writeWSJSON(ctx, wsConn, map[string]any{
			"type": model.MsgServerMetrics,
			"data": metrics,
		})
	}

	// Start metrics collection loop. Sampling is instant; CPU/network rates are
	// derived from deltas between successive snapshots stored in the session.
	metricsTicker := time.NewTicker(3 * time.Second)
	defer metricsTicker.Stop()

	// Read loop (handles ping/pong and close)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, data, readErr := wsConn.Read(ctx)
			if readErr != nil {
				return
			}
			var m map[string]string
			if jsonErr := json.Unmarshal(data, &m); jsonErr == nil {
				switch m["type"] {
				case model.MsgPing:
					writeWSJSON(ctx, wsConn, map[string]string{"type": model.MsgPong})
				}
			}
		}
	}()

	for {
		select {
		case <-readDone:
			return
		case <-session.done:
			return
		case <-metricsTicker.C:
			if entry.Exec == nil {
				continue
			}
			metrics := h.collectMetrics(session, entry)
			metrics.Timestamp = time.Now().UnixMilli()

			if err := writeWSJSON(ctx, wsConn, map[string]any{
				"type": model.MsgServerMetrics,
				"data": metrics,
			}); err != nil {
				slog.Error("server detail ws write failed", "error", err)
				return
			}
		}
	}
}

// writeWSJSON marshals v to JSON and writes it as a text WebSocket message.
func writeWSJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

// GetSessionBackend returns the FileBackend for a session, if it exists and
// is connected. Used by EditHandler for unified file editing.
func (h *ServerDetailHandler) GetSessionBackend(sessionID string) (fileutil.FileBackend, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	session, ok := h.sessions[sessionID]
	if !ok || session.Status != "connected" || session.Entry == nil || session.Entry.Backend == nil {
		return nil, false
	}
	return session.Entry.Backend, true
}

// --- Internal helpers ---

// resolveSession extracts the session, validates it, and returns the
// session + pool entry.
func (h *ServerDetailHandler) resolveSession(w http.ResponseWriter, r *http.Request) (*ServerDetailSession, *connpool.Entry, bool) {
	id := r.PathValue("id")
	h.mu.RLock()
	session, ok := h.sessions[id]
	h.mu.RUnlock()
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "session not found")
		return nil, nil, false
	}
	if session.Status != "connected" || session.Entry == nil {
		if session.Status == "disconnected" {
			writeError(w, http.StatusConflict, "NOT_CONNECTED", session.Error)
		} else {
			writeError(w, http.StatusConflict, "NOT_CONNECTED", "session is "+session.Status)
		}
		return nil, nil, false
	}
	return session, session.Entry, true
}

func (h *ServerDetailHandler) resolveHomeDir(username string, entry *connpool.Entry) string {
	fallback := "/root"
	if username != "root" && username != "" {
		fallback = "/home/" + username
	}
	if entry == nil || entry.Exec == nil {
		return fallback
	}

	stdout, _, exitCode, err := entry.Exec.Exec(`printf '%s' "$HOME"`)
	if err != nil && exitCode != 0 {
		return fallback
	}

	homeDir := strings.TrimSpace(string(stdout))
	if homeDir == "" || !strings.HasPrefix(homeDir, "/") {
		return fallback
	}
	return homeDir
}

// collectServerInfo runs commands to gather static server information.
func (h *ServerDetailHandler) collectServerInfo(entry *connpool.Entry) model.ServerInfo {
	info := model.ServerInfo{}
	if entry.Exec == nil {
		return info
	}

	cmd := `echo "===HOSTNAME===" && hostname -f 2>/dev/null || hostname && ` +
		`echo "===OS===" && (cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -o 2>/dev/null || echo "Unknown") && ` +
		`echo "===KERNEL===" && uname -r && ` +
		`echo "===ARCH===" && uname -m && ` +
		`echo "===UPTIME===" && (uptime -p 2>/dev/null || uptime) && ` +
		`echo "===LOAD===" && (cat /proc/loadavg 2>/dev/null || uptime | awk -F'load average:' '{print $2}') && ` +
		`echo "===CPUS===" && (nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)`

	stdout, _, exitCode, err := entry.Exec.Exec(cmd)
	if err != nil && exitCode != 0 {
		slog.Warn("server detail: collect info failed", "error", err)
		return info
	}

	return parseServerInfo(string(stdout))
}

// collectMetrics gathers CPU (total + per-core), memory, disk, top processes,
// and per-interface network speed via a single SSH session.
//
// Timing: one 1s sleep is shared between CPU and network delta sampling.
// Static reads (memory/disk/ps) happen concurrently during the sleep.
//
// Output protocol — one metric per line:
//
//	CPU: 12.3
//	CORE0: 8.1
//	CORE1: 15.2
//	MEM_USED: 1234567890
//	MEM_TOTAL: 4000000000
//	MEM_PROC: nginx 12.5 524288
//	DISK_USED: 5000000000
//	DISK_TOTAL: 20000000000
//	IFACE:eth0: 12345 67890
func (h *ServerDetailHandler) collectMetricsLegacy(session *ServerDetailSession, entry *connpool.Entry) model.ServerMetrics {
	metrics := model.ServerMetrics{}
	if entry.Exec == nil {
		return metrics
	}

	// Split into 3 independent SSH commands to avoid nested-quote issues.
	// Commands 1 and 3 each take ~1s (sleep for delta); command 2 is instant.
	// Run all 3 in parallel — total wall time ≈ 1s.

	// Command 1: CPU (total + per-core) — two /proc/stat samples 1s apart
	cpuCmd := `awk '/^cpu /{print "T",$2+$3+$4,$5}/^cpu[0-9]/{gsub(/cpu/,"",$1);print "C"$1,$2+$3+$4,$5}' /proc/stat; sleep 1; awk '/^cpu /{print "T",$2+$3+$4,$5}/^cpu[0-9]/{gsub(/cpu/,"",$1);print "C"$1,$2+$3+$4,$5}' /proc/stat`

	// Command 2: Memory + Disk + Top processes (instant)
	staticCmd := `free -b | awk 'NR==2{print "MU",$3;print "MT",$2}'; df -B1 / | awk 'NR==2{print "DU",$3;print "DT",$2}'; ps -eo comm=,%mem=,rss= --sort=-%mem | head -6 | awk '{print "MP",$1,$2,$3*1024}'`

	// Command 3: Network per-interface — two /proc/net/dev samples 1s apart
	netCmd := `awk 'NR>2 && $1~/^(eth|ens|enp|eno|wlan|wl|tailscale|netbird|wg)/{gsub(/:/," ");print $1,$2,$10}' /proc/net/dev; sleep 1; awk 'NR>2 && $1~/^(eth|ens|enp|eno|wlan|wl|tailscale|netbird|wg)/{gsub(/:/," ");print $1,$2,$10}' /proc/net/dev`

	var wg sync.WaitGroup
	var cpuOut, staticOut, netOut []byte

	wg.Add(3)
	go func() { defer wg.Done(); cpuOut, _, _, _ = entry.Exec.Exec(cpuCmd) }()
	go func() { defer wg.Done(); staticOut, _, _, _ = entry.Exec.Exec(staticCmd) }()
	go func() { defer wg.Done(); netOut, _, _, _ = entry.Exec.Exec(netCmd) }()
	wg.Wait()

	// Parse CPU: two blocks of "T active idle" / "Cn active idle" lines
	cpuLines := strings.Split(strings.TrimSpace(string(cpuOut)), "\n")
	half := len(cpuLines) / 2
	if half > 0 {
		for i := 0; i < half; i++ {
			p1 := strings.Fields(cpuLines[i])
			p2 := strings.Fields(cpuLines[i+half])
			if len(p1) >= 3 && len(p2) >= 3 && p1[0] == p2[0] {
				a1, _ := strconv.ParseFloat(p1[1], 64)
				i1, _ := strconv.ParseFloat(p1[2], 64)
				a2, _ := strconv.ParseFloat(p2[1], 64)
				i2, _ := strconv.ParseFloat(p2[2], 64)
				da := a2 - a1
				di := i2 - i1
				dt := da + di
				if dt > 0 {
					pct := da / dt * 100
					if p1[0] == "T" {
						metrics.CPU = pct
					} else {
						metrics.CPUDetail = append(metrics.CPUDetail, pct)
					}
				}
			}
		}
	}

	// Parse static: MU/MT/DU/DT/MP lines
	for _, line := range strings.Split(strings.TrimSpace(string(staticOut)), "\n") {
		parts := strings.Fields(strings.TrimSpace(line))
		if len(parts) < 2 {
			continue
		}
		switch parts[0] {
		case "MU":
			metrics.MemUsed, _ = strconv.ParseInt(parts[1], 10, 64)
		case "MT":
			metrics.MemTotal, _ = strconv.ParseInt(parts[1], 10, 64)
		case "DU":
			metrics.DiskUsed, _ = strconv.ParseInt(parts[1], 10, 64)
		case "DT":
			metrics.DiskTotal, _ = strconv.ParseInt(parts[1], 10, 64)
		case "MP":
			if len(parts) >= 4 {
				proc := model.ProcMem{Name: parts[1]}
				proc.Percent, _ = strconv.ParseFloat(parts[2], 64)
				proc.RSS, _ = strconv.ParseInt(parts[3], 10, 64)
				metrics.MemDetail = append(metrics.MemDetail, proc)
			}
		}
	}

	// Parse network: two blocks of "iface rx tx" lines
	netLines := strings.Split(strings.TrimSpace(string(netOut)), "\n")
	netHalf := len(netLines) / 2
	if netHalf > 0 {
		for i := 0; i < netHalf; i++ {
			p1 := strings.Fields(netLines[i])
			p2 := strings.Fields(netLines[i+netHalf])
			if len(p1) >= 3 && len(p2) >= 3 && p1[0] == p2[0] {
				rx1, _ := strconv.ParseInt(p1[1], 10, 64)
				tx1, _ := strconv.ParseInt(p1[2], 10, 64)
				rx2, _ := strconv.ParseInt(p2[1], 10, 64)
				tx2, _ := strconv.ParseInt(p2[2], 10, 64)
				rx := rx2 - rx1
				tx := tx2 - tx1
				if rx < 0 {
					rx = 0
				}
				if tx < 0 {
					tx = 0
				}
				metrics.NetDetail = append(metrics.NetDetail, model.NetIfStat{
					Name: p1[0], Rx: rx, Tx: tx,
				})
				metrics.NetRx += rx
				metrics.NetTx += tx
			}
		}
	}

	if metrics.MemTotal > 0 {
		metrics.MemPercent = float64(metrics.MemUsed) / float64(metrics.MemTotal) * 100
	}
	if metrics.DiskTotal > 0 {
		metrics.DiskPercent = float64(metrics.DiskUsed) / float64(metrics.DiskTotal) * 100
	}
	return metrics
}

// collectMetrics captures an instant raw snapshot from the remote host and
// derives CPU/network rates from the previous snapshot cached on the session.
func (h *ServerDetailHandler) collectMetrics(session *ServerDetailSession, entry *connpool.Entry) model.ServerMetrics {
	metrics := model.ServerMetrics{}
	if session == nil || entry == nil || entry.Exec == nil {
		return metrics
	}

	current, err := h.collectRawMetrics(entry)
	if err != nil {
		slog.Warn("server detail: collect metrics failed", "error", err)
		return metrics
	}

	metrics.MemUsed = current.memUsed
	metrics.MemTotal = current.memTotal
	metrics.MemDetail = current.memDetail
	metrics.DiskUsed = current.diskUsed
	metrics.DiskTotal = current.diskTotal
	if metrics.MemTotal > 0 {
		metrics.MemPercent = float64(metrics.MemUsed) / float64(metrics.MemTotal) * 100
	}
	if metrics.DiskTotal > 0 {
		metrics.DiskPercent = float64(metrics.DiskUsed) / float64(metrics.DiskTotal) * 100
	}

	session.sampleMu.Lock()
	prev := session.lastSample
	session.lastSample = current
	session.sampleMu.Unlock()

	if prev == nil {
		return metrics
	}

	elapsed := current.takenAt.Sub(prev.takenAt)
	if elapsed < time.Second {
		return metrics
	}

	metrics.CPU = cpuPercent(prev.cpu, current.cpu)
	for i, curCore := range current.cpuDetail {
		if i < len(prev.cpuDetail) {
			metrics.CPUDetail = append(metrics.CPUDetail, cpuPercent(prev.cpuDetail[i], curCore))
		}
	}

	seconds := elapsed.Seconds()
	if seconds <= 0 {
		return metrics
	}

	for name, curNet := range current.netDetail {
		if isIgnoredNetInterface(name) {
			continue
		}
		prevNet, ok := prev.netDetail[name]
		if !ok {
			metrics.NetDetail = append(metrics.NetDetail, model.NetIfStat{Name: name})
			continue
		}
		rxDelta := counterDelta(prevNet.rx, curNet.rx)
		txDelta := counterDelta(prevNet.tx, curNet.tx)
		rxPerSec := int64(float64(rxDelta) / seconds)
		txPerSec := int64(float64(txDelta) / seconds)
		metrics.NetDetail = append(metrics.NetDetail, model.NetIfStat{
			Name: name,
			Rx:   rxPerSec,
			Tx:   txPerSec,
		})
		metrics.NetRx += rxPerSec
		metrics.NetTx += txPerSec
	}

	return metrics
}

func (h *ServerDetailHandler) collectRawMetrics(entry *connpool.Entry) (*rawMetricsSnapshot, error) {
	if entry == nil || entry.Exec == nil {
		return nil, fmt.Errorf("command execution not available")
	}

	cmd := `awk '/^cpu /{print "CT",$2,$3,$4,$5,$6,$7,$8,$9}/^cpu[0-9]+ /{core=$1; sub(/^cpu/,"",core); print "CC",core,$2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat; ` +
		`awk '/^MemTotal:/{mt=$2*1024}/^MemAvailable:/{ma=$2*1024} END{print "MT",mt; print "MA",ma}' /proc/meminfo; ` +
		`df -B1 -P / | awk 'NR==2{print "DU",$3; print "DT",$2}'; ` +
		`ps -eo pid=,comm=,rss=,%cpu=,%mem= --sort=-rss | head -6 | awk '{print "MP",$2,$5,$3*1024}'; ` +
		`awk 'NR>2{iface=$1; gsub(/:/,"",iface); print "NI",iface,$2,$10}' /proc/net/dev`

	stdout, _, exitCode, err := entry.Exec.Exec(cmd)
	if err != nil && exitCode != 0 {
		return nil, fmt.Errorf("command failed: %w", err)
	}

	snapshot := &rawMetricsSnapshot{
		takenAt:   time.Now(),
		netDetail: make(map[string]netCounters),
	}

	var memAvailable int64
	for _, line := range strings.Split(strings.TrimSpace(string(stdout)), "\n") {
		parts := strings.Fields(strings.TrimSpace(line))
		if len(parts) == 0 {
			continue
		}
		switch parts[0] {
		case "CT":
			if len(parts) >= 9 {
				snapshot.cpu = parseCPUCounters(parts[1:9])
			}
		case "CC":
			if len(parts) >= 10 {
				snapshot.cpuDetail = append(snapshot.cpuDetail, parseCPUCounters(parts[2:10]))
			}
		case "MT":
			snapshot.memTotal = parseInt64(parts, 1)
		case "MA":
			memAvailable = parseInt64(parts, 1)
		case "DU":
			snapshot.diskUsed = parseInt64(parts, 1)
		case "DT":
			snapshot.diskTotal = parseInt64(parts, 1)
		case "MP":
			if len(parts) >= 4 {
				proc := model.ProcMem{Name: parts[1]}
				proc.Percent, _ = strconv.ParseFloat(parts[2], 64)
				proc.RSS = parseInt64(parts, 3)
				snapshot.memDetail = append(snapshot.memDetail, proc)
			}
		case "NI":
			if len(parts) >= 4 {
				snapshot.netDetail[parts[1]] = netCounters{
					rx: parseUint64(parts, 2),
					tx: parseUint64(parts, 3),
				}
			}
		}
	}

	if snapshot.memTotal > 0 {
		snapshot.memUsed = snapshot.memTotal - memAvailable
		if snapshot.memUsed < 0 {
			snapshot.memUsed = 0
		}
	}

	return snapshot, nil
}

func isIgnoredNetInterface(name string) bool {
	return name == "lo" || strings.HasPrefix(name, "br-")
}

func parseCPUCounters(parts []string) cpuCounters {
	var values [8]uint64
	for i := range values {
		if i < len(parts) {
			v, _ := strconv.ParseUint(parts[i], 10, 64)
			values[i] = v
		}
	}
	total := values[0] + values[1] + values[2] + values[3] + values[4] + values[5] + values[6] + values[7]
	idle := values[3] + values[4]
	return cpuCounters{total: total, idle: idle}
}

func parseInt64(parts []string, idx int) int64 {
	if idx >= len(parts) {
		return 0
	}
	v, _ := strconv.ParseInt(parts[idx], 10, 64)
	return v
}

func parseUint64(parts []string, idx int) uint64 {
	if idx >= len(parts) {
		return 0
	}
	v, _ := strconv.ParseUint(parts[idx], 10, 64)
	return v
}

func cpuPercent(prev, cur cpuCounters) float64 {
	totalDelta := counterDelta(prev.total, cur.total)
	idleDelta := counterDelta(prev.idle, cur.idle)
	if totalDelta == 0 || idleDelta > totalDelta {
		return 0
	}
	return float64(totalDelta-idleDelta) / float64(totalDelta) * 100
}

func counterDelta(prev, cur uint64) uint64 {
	if cur < prev {
		return 0
	}
	return cur - prev
}

// parseServerInfo parses the compound command output into a ServerInfo struct.
func parseServerInfo(output string) model.ServerInfo {
	info := model.ServerInfo{}
	sections := strings.Split(output, "===")

	getSection := func(name string) string {
		for i, s := range sections {
			if strings.TrimSpace(s) == name && i+1 < len(sections) {
				return strings.TrimSpace(sections[i+1])
			}
		}
		return ""
	}

	info.Hostname = getSection("HOSTNAME")
	info.OS = getSection("OS")
	info.Kernel = getSection("KERNEL")
	info.Arch = getSection("ARCH")
	info.Uptime = getSection("UPTIME")
	rawLoad := getSection("LOAD")
	info.LoadAvgDetail = rawLoad
	// Format: "0.00 0.01 0.00 1/354 308603" → "0.00 / 0.01 / 0.00"
	if parts := strings.Fields(rawLoad); len(parts) >= 3 {
		info.LoadAvg = parts[0] + " / " + parts[1] + " / " + parts[2]
	} else {
		info.LoadAvg = rawLoad
	}
	if v, err := strconv.Atoi(getSection("CPUS")); err == nil {
		info.CPUs = v
	} else {
		info.CPUs = 1
	}

	return info
}
