package handler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/yuweinfo/xcontrol/model"
	sshproto "github.com/yuweinfo/xcontrol/protocol/ssh"
)

const profileTestTimeout = 45 * time.Second

func (h *ProfileHandler) TestNewConnection(w http.ResponseWriter, r *http.Request) {
	var req model.ProfileCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	profile, err := h.profileDraftFromCreate(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}
	h.runProfileConnectionTest(w, r, profile)
}

func (h *ProfileHandler) TestExistingConnection(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	current, err := h.profiles.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}
	var req model.ProfileUpdateRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_JSON", err.Error())
		return
	}
	if err := h.prepareCredentialOnUpdate(current, &req); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}
	if err := h.prepareProxyOnUpdate(current, &req); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_PROXY_CONFIG", err.Error())
		return
	}
	draft := applyProfileDraftUpdate(current, &req)
	h.runProfileConnectionTest(w, r, draft)
}

func (h *ProfileHandler) profileDraftFromCreate(req *model.ProfileCreateRequest) (*model.Profile, error) {
	req.Host = strings.TrimSpace(req.Host)
	req.Username = strings.TrimSpace(req.Username)
	if req.Host == "" || req.Username == "" {
		return nil, fmt.Errorf("主机和用户名不能为空")
	}
	if req.Port == 0 {
		req.Port = 22
	}
	if req.AuthType == "" {
		req.AuthType = "password"
	}
	proxy, err := normalizeProxyInput(req.Proxy)
	if err != nil {
		return nil, err
	}
	id := "draft-" + uuid.NewString()
	if err := validateProxyChain(h.profiles, id, proxy); err != nil {
		return nil, err
	}
	options, err := model.WithProxyOptions(req.Options, proxy)
	if err != nil {
		return nil, fmt.Errorf("连接高级配置不是有效 JSON")
	}
	vaultID, inline, err := h.prepareCredentialOnCreate(req)
	if err != nil {
		return nil, err
	}
	proxyCredential := ""
	if req.Proxy != nil && req.Proxy.Password != nil {
		proxyCredential, err = encodeProxyPassword(*req.Proxy.Password, h.encryptor)
		if err != nil {
			return nil, err
		}
	}
	if proxy.Username != "" && proxyCredential == "" {
		return nil, fmt.Errorf("代理用户名和密码必须同时填写")
	}
	return &model.Profile{
		ID: id, Name: req.Name, Host: req.Host, Port: req.Port, Username: req.Username,
		AuthType: req.AuthType, VaultID: vaultID, InlineCredential: inline,
		ProxyCredential: proxyCredential, Proxy: proxy, Options: options, UpdatedAt: time.Now(),
	}, nil
}

func applyProfileDraftUpdate(current *model.Profile, req *model.ProfileUpdateRequest) *model.Profile {
	draft := *current
	if req.Name != nil {
		draft.Name = *req.Name
	}
	if req.Host != nil {
		draft.Host = strings.TrimSpace(*req.Host)
	}
	if req.Port != nil {
		draft.Port = *req.Port
	}
	if req.Username != nil {
		draft.Username = strings.TrimSpace(*req.Username)
	}
	if req.AuthType != nil {
		draft.AuthType = *req.AuthType
	}
	if req.VaultID != nil {
		draft.VaultID = *req.VaultID
	}
	if req.InlineCredential != nil {
		draft.InlineCredential = *req.InlineCredential
	}
	if req.ProxyCredential != nil {
		draft.ProxyCredential = *req.ProxyCredential
	}
	if req.Options != nil {
		draft.Options = *req.Options
	}
	draft.Proxy = model.ParseProxyOptions(draft.Options)
	draft.Proxy.HasPassword = draft.ProxyCredential != ""
	draft.UpdatedAt = time.Now()
	return &draft
}

func (h *ProfileHandler) runProfileConnectionTest(w http.ResponseWriter, r *http.Request, profile *model.Profile) {
	started := time.Now()
	stages := make([]model.ProfileTestStage, 0)
	ctx, cancel := context.WithTimeout(r.Context(), profileTestTimeout)
	defer cancel()
	resolved, err := resolveProfileConnection(ctx, profile, h.profiles, h.vault, h.encryptor, nil, func(stage model.ProfileTestStage) {
		stages = append(stages, stage)
	})
	if err == nil {
		authStarted := time.Now()
		client, dialErr := sshproto.Dial(ctx, resolved.Opts())
		if dialErr == nil {
			client.Close()
			stages = append(stages, model.ProfileTestStage{Stage: "ssh_auth", Status: "success", ProfileID: profile.ID, ProfileName: profile.Name, Message: "SSH 握手与认证成功", LatencyMs: time.Since(authStarted).Milliseconds()})
			writeJSON(w, http.StatusOK, model.ProfileTestResult{Success: true, Message: "连接测试成功", LatencyMs: time.Since(started).Milliseconds(), Stages: stages})
			return
		}
		err = dialErr
	}
	var hostKeyErr *HostKeyChangedError
	if !errors.As(err, &hostKeyErr) {
		stages = append(stages, model.ProfileTestStage{Stage: "ssh_auth", Status: "error", ProfileID: profile.ID, ProfileName: profile.Name, Message: err.Error()})
	}
	writeJSON(w, http.StatusOK, model.ProfileTestResult{Success: false, Message: "连接测试失败: " + err.Error(), LatencyMs: time.Since(started).Milliseconds(), Stages: stages})
}

func (h *ProfileHandler) ConfirmHostKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	profile, err := h.profiles.Get(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "profile not found")
		return
	}
	var req struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := decodeJSON(r, &req); err != nil || req.Fingerprint == "" {
		writeError(w, http.StatusBadRequest, "VALIDATION", "fingerprint is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), profileTestTimeout)
	defer cancel()
	visited := map[string]bool{}
	node, err := buildResolvedNode(profile, h.profiles, h.vault, h.encryptor, visited, 0, nil)
	if err == nil && node.jump != nil {
		err = verifyResolvedNode(ctx, node.jump, nil, nil)
		node.opts.JumpHost = &node.jump.opts
	}
	if err != nil {
		writeError(w, http.StatusBadGateway, "HOST_KEY_CHECK_FAILED", err.Error())
		return
	}
	current, err := sshproto.InspectHostKeyFingerprint(ctx, node.opts)
	if err != nil {
		writeError(w, http.StatusBadGateway, "HOST_KEY_CHECK_FAILED", err.Error())
		return
	}
	if current != req.Fingerprint {
		writeError(w, http.StatusConflict, "HOST_KEY_CHANGED_AGAIN", "服务器主机指纹已再次变化，请重新测试")
		return
	}
	options, err := withProfileHostKeyFingerprint(profile.Options, current)
	if err != nil || h.profiles.Update(profile.ID, &model.ProfileUpdateRequest{Options: &options}) != nil {
		writeError(w, http.StatusInternalServerError, "DB_ERROR", "保存主机指纹失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "fingerprint": current})
}
