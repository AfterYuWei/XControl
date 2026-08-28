package handler

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/yuweinfo/xcontrol/fileutil"
	"github.com/yuweinfo/xcontrol/model"
)

// Move performs a preflighted batch move inside one SFTP session. SFTP does
// not provide transactions, so execution failures are returned per item.
func (h *SftpHandler) Move(w http.ResponseWriter, r *http.Request) {
	session, backend, ok := h.resolveSession(w, r)
	if !ok {
		return
	}

	var req model.SftpMoveRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if len(req.Paths) == 0 || req.DestDir == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "paths and dest_dir are required")
		return
	}

	resolution := req.ConflictResolution
	if resolution == "" {
		resolution = model.ConflictAsk
	}
	if !validConflictResolution(resolution) {
		writeError(w, http.StatusBadRequest, "VALIDATION", "invalid conflict_resolution")
		return
	}

	ctx, cancel := h.opCtx(r, session)
	defer cancel()
	destDir := fileutil.CleanPath(req.DestDir)
	destInfo, err := backend.Stat(ctx, destDir)
	if err != nil || !destInfo.IsDir {
		writeError(w, http.StatusBadRequest, "INVALID_DESTINATION", "dest_dir must be an existing directory")
		return
	}

	paths := make([]string, 0, len(req.Paths))
	infos := make(map[string]fileutil.FileInfo, len(req.Paths))
	conflicts := make([]model.SftpConflictInfo, 0)
	for _, raw := range req.Paths {
		p := fileutil.CleanPath(raw)
		if p == "/" || fileutil.ParentPath(p) == destDir {
			writeError(w, http.StatusBadRequest, "INVALID_DESTINATION", "cannot move root or move an item to its current parent")
			return
		}
		info, statErr := backend.Stat(ctx, p)
		if statErr != nil {
			writeError(w, http.StatusNotFound, "NOT_FOUND", statErr.Error())
			return
		}
		if info.IsDir && pathWithin(destDir, p) {
			writeError(w, http.StatusBadRequest, "INVALID_DESTINATION", "cannot move a directory into itself")
			return
		}
		paths = append(paths, p)
		infos[p] = info
		target := fileutil.JoinPath(destDir, info.Name)
		if targetInfo, statErr := backend.Stat(ctx, target); statErr == nil {
			conflicts = append(conflicts, model.SftpConflictInfo{
				SourcePath: p, DestPath: target,
				SourceSize: info.Size, DestSize: targetInfo.Size,
				SourceIsDir: info.IsDir, DestIsDir: targetInfo.IsDir,
			})
		}
	}

	if len(conflicts) > 0 && resolution == model.ConflictAsk {
		writeJSON(w, http.StatusConflict, model.SftpMoveResponse{Conflicts: conflicts})
		return
	}

	result := model.SftpMoveResponse{
		Moved: []string{}, Skipped: []string{}, Failures: []model.SftpMoveFailure{},
	}
	for _, p := range paths {
		info := infos[p]
		target := fileutil.JoinPath(destDir, info.Name)
		if _, statErr := backend.Stat(ctx, target); statErr == nil {
			switch resolution {
			case model.ConflictOverwrite:
				if removeErr := fileutil.RemoveAll(ctx, backend, target); removeErr != nil {
					result.Failures = append(result.Failures, model.SftpMoveFailure{Path: p, Message: removeErr.Error()})
					continue
				}
			case model.ConflictRename:
				var renameErr error
				target, renameErr = fileutil.AutoRename(ctx, backend, target)
				if renameErr != nil {
					result.Failures = append(result.Failures, model.SftpMoveFailure{Path: p, Message: renameErr.Error()})
					continue
				}
			case model.ConflictSkip:
				result.Skipped = append(result.Skipped, p)
				continue
			}
		}
		if moveErr := backend.Rename(ctx, p, target); moveErr != nil {
			result.Failures = append(result.Failures, model.SftpMoveFailure{Path: p, Message: moveErr.Error()})
			continue
		}
		result.Moved = append(result.Moved, target)
	}

	h.auditSftp(session.ProfileID, "sftp_move", fmt.Sprintf("dest=%s moved=%d skipped=%d failed=%d", destDir, len(result.Moved), len(result.Skipped), len(result.Failures)))
	if len(result.Failures) > 0 {
		slog.Warn("sftp batch move partially failed", "dest", destDir, "failures", len(result.Failures))
	}
	writeJSON(w, http.StatusOK, result)
}

func validConflictResolution(v model.ConflictResolution) bool {
	return v == model.ConflictAsk || v == model.ConflictOverwrite || v == model.ConflictRename || v == model.ConflictSkip
}

func pathWithin(candidate, root string) bool {
	candidate = fileutil.CleanPath(candidate)
	root = fileutil.CleanPath(root)
	return candidate == root || strings.HasPrefix(candidate, strings.TrimSuffix(root, "/")+"/")
}
