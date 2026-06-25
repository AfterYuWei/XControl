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

	"github.com/yuweinfo/sshx/connpool"
	"github.com/yuweinfo/sshx/model"
	"github.com/yuweinfo/sshx/protocol"
	"github.com/yuweinfo/sshx/store"
)

// ServerDetailSession holds a pooled connection entry used for file browsing
// (via SFTP backend) and command execution (via SSH exec).
type ServerDetailSession struct {
	ID        string
	ProfileID string
	Entry     *connpool.Entry // shared connection from pool
	Status    string          // connecting | connected | disconnected
	Error     string
	CreatedAt time.Time

	cancel context.CancelFunc
	done   chan struct{}
}

// ServerDetailHandler manages "management connections" — one per server —
// that provide file browsing (SFTP) and system metrics (SSH exec).
// All connections go through the connection pool; no independent SSH
// connections are created.
type ServerDetailHandler struct {
	sessions map[string]*ServerDetailSession
	mu       sync.RWMutex
	profiles store.ProfileStore
	vault    store.VaultStore
	pool     *connpool.Pool
}

func NewServerDetailHandler(ps store.ProfileStore, vs store.VaultStore, pool *connpool.Pool) *ServerDetailHandler {
	return &ServerDetailHandler{
		sessions: make(map[string]*ServerDetailSession),
		profiles: ps,
		vault:    vs,
		pool:     pool,
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

	var password, privKey, passphrase string
	if profile.VaultID != "" {
		cred, err := h.vault.Retrieve(profile.VaultID)
		if err != nil {
			slog.Warn("server detail: failed to retrieve vault credential", "error", err)
		} else {
			password = cred.Password
			privKey = cred.PrivKey
			passphrase = cred.Passphrase
		}
	}

	opts := protocol.DriverOpts{
		Host:       profile.Host,
		Port:       profile.Port,
		Username:   profile.Username,
		Password:   password,
		PrivKey:    privKey,
		Passphrase: passphrase,
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
	session := &ServerDetailSession{
		ID:        sessionID,
		ProfileID: req.ProfileID,
		Entry:     entry,
		Status:    "connected",
		CreatedAt: time.Now(),
		cancel:    func() {},
		done:      make(chan struct{}),
	}

	h.mu.Lock()
	h.sessions[sessionID] = session
	h.mu.Unlock()

	writeJSON(w, http.StatusCreated, model.ServerSessionResponse{
		SessionID: sessionID,
		Status:    "connected",
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

	close(session.done)
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
		result = append(result, toSftpEntry(e))
	}
	_ = session
	writeJSON(w, http.StatusOK, model.SftpListResponse{
		Path:    p,
		Entries: result,
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
		metrics := h.collectMetrics(entry)
		metrics.Timestamp = time.Now().UnixMilli()
		writeWSJSON(ctx, wsConn, map[string]any{
			"type": model.MsgServerMetrics,
			"data": metrics,
		})
	}

	// Start metrics collection loop
	metricsTicker := time.NewTicker(5 * time.Second)
	defer metricsTicker.Stop()

	// Track previous net stats for rate calculation
	var prevNetRx, prevNetTx int64
	var prevNetTime time.Time

	// Collect initial net baseline
	if entry.Exec != nil {
		rx, tx := h.collectNetStats(entry)
		prevNetRx = rx
		prevNetTx = tx
		prevNetTime = time.Now()
	}

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
			metrics := h.collectMetrics(entry)

			// Calculate net rate from raw byte counters
			now := time.Now()
			if !prevNetTime.IsZero() {
				elapsed := now.Sub(prevNetTime).Seconds()
				if elapsed > 0 {
					metrics.NetRx = int64(float64(metrics.NetRx-prevNetRx) / elapsed)
					metrics.NetTx = int64(float64(metrics.NetTx-prevNetTx) / elapsed)
					if metrics.NetRx < 0 {
						metrics.NetRx = 0
					}
					if metrics.NetTx < 0 {
						metrics.NetTx = 0
					}
				}
			}
			prevNetTime = now

			// Re-read raw net for next delta
			rx, tx := h.collectNetStats(entry)
			prevNetRx = rx
			prevNetTx = tx

			metrics.Timestamp = now.UnixMilli()

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

// collectMetrics runs commands to gather dynamic system metrics.
// Uses /proc-based commands where possible for reliability (no external tools
// like top/free that may hang or have locale-dependent output).
func (h *ServerDetailHandler) collectMetrics(entry *connpool.Entry) model.ServerMetrics {
	metrics := model.ServerMetrics{}
	if entry.Exec == nil {
		return metrics
	}

	// Single compound command — one SSH session.
	// CPU: two /proc/stat samples 1s apart for live percentage.
	// Memory: /proc/meminfo (MemTotal - MemFree - Buffers - Cached).
	// Disk: df -B1 / (POSIX standard).
	//
	// Output format (4 lines):
	//   Line 0: cpu_idle% (from two-sample delta, 0-100)
	//   Line 1: mem_used_bytes mem_total_bytes
	//   Line 2: disk_used_bytes disk_total_bytes
	cmd := `sh -c '` +
		`read_cpu(){ awk "/^cpu /{print \$4, \$2+\$3+\$4+\$5+\$6+\$7+\$8}" /proc/stat; }; ` +
		`read1=$(read_cpu); sleep 1; read2=$(read_cpu); ` +
		`idle1=$(echo "$read1" | awk "{print \$1}"); total1=$(echo "$read1" | awk "{print \$2}"); ` +
		`idle2=$(echo "$read2" | awk "{print \$1}"); total2=$(echo "$read2" | awk "{print \$2}"); ` +
		`dt=$((total2 - total1)); di=$((idle2 - idle1)); ` +
		`if [ "$dt" -gt 0 ]; then echo $(( (dt - di) * 100 / dt )); else echo 0; fi; ` +
		`awk "/^MemTotal:/{t=\$2} /^MemFree:/{f=\$2} /^Buffers:/{b=\$2} /^Cached:/{c=\$2} END{print (t-f-b-c)*1024, t*1024}" /proc/meminfo; ` +
		`df -B1 / | awk "NR==2{print \$3, \$2}"` + `'`

	stdout, _, _, err := entry.Exec.Exec(cmd)
	if err != nil {
		slog.Warn("server detail: collectMetrics failed", "error", err)
		return metrics
	}

	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")

	// Line 0: CPU percentage (0-100, integer from shell arithmetic)
	if len(lines) >= 1 {
		cpuStr := strings.TrimSpace(lines[0])
		if v, err := strconv.ParseFloat(cpuStr, 64); err == nil {
			metrics.CPU = v
		}
	}

	// Line 1: Memory — "used_bytes total_bytes"
	if len(lines) >= 2 {
		memParts := strings.Fields(lines[1])
		if len(memParts) >= 2 {
			if used, err := strconv.ParseInt(memParts[0], 10, 64); err == nil {
				metrics.MemUsed = used
			}
			if total, err := strconv.ParseInt(memParts[1], 10, 64); err == nil {
				metrics.MemTotal = total
			}
			if metrics.MemTotal > 0 {
				metrics.MemPercent = float64(metrics.MemUsed) / float64(metrics.MemTotal) * 100
			}
		}
	}

	// Line 2: Disk — "used_bytes total_bytes"
	if len(lines) >= 3 {
		diskParts := strings.Fields(lines[2])
		if len(diskParts) >= 2 {
			if used, err := strconv.ParseInt(diskParts[0], 10, 64); err == nil {
				metrics.DiskUsed = used
			}
			if total, err := strconv.ParseInt(diskParts[1], 10, 64); err == nil {
				metrics.DiskTotal = total
			}
			if metrics.DiskTotal > 0 {
				metrics.DiskPercent = float64(metrics.DiskUsed) / float64(metrics.DiskTotal) * 100
			}
		}
	}

	return metrics
}

// collectNetStats reads raw network byte counters from /proc/net/dev.
func (h *ServerDetailHandler) collectNetStats(entry *connpool.Entry) (rx int64, tx int64) {
	if entry.Exec == nil {
		return 0, 0
	}
	cmd := `cat /proc/net/dev | awk 'NR>2 && $1!~/lo/{gsub(/:/, " "); split($0, f); rx+=f[2]; tx+=f[10]} END{print rx, tx}'`
	out, _, _, err := entry.Exec.Exec(cmd)
	if err != nil {
		return 0, 0
	}
	parts := strings.Fields(strings.TrimSpace(string(out)))
	if len(parts) >= 2 {
		rx, _ = strconv.ParseInt(parts[0], 10, 64)
		tx, _ = strconv.ParseInt(parts[1], 10, 64)
	}
	return rx, tx
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
