package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/protocol"
	sshproto "github.com/yuweinfo/xcontrol/protocol/ssh"
	"github.com/yuweinfo/xcontrol/store"
)

type hostKeyMismatchHandler func(profile *model.Profile, current, known string) bool
type connectionStageHandler func(stage model.ProfileTestStage)

type resolvedProfileNode struct {
	profile            *model.Profile
	opts               protocol.DriverOpts
	jump               *resolvedProfileNode
	currentFingerprint string
}

type resolvedProfileConnection struct {
	root     *resolvedProfileNode
	profiles store.ProfileStore
}

type HostKeyChangedError struct {
	ProfileID   string
	ProfileName string
	Known       string
	Current     string
}

func (e *HostKeyChangedError) Error() string {
	return fmt.Sprintf("%s 的 SSH 主机指纹已变化（已保存: %s，当前: %s），请在连接配置中测试并确认", e.ProfileName, e.Known, e.Current)
}

func resolveProfileConnection(
	ctx context.Context,
	profile *model.Profile,
	profiles store.ProfileStore,
	vault store.VaultStore,
	encryptor *crypto.Encryptor,
	onMismatch hostKeyMismatchHandler,
	onStage connectionStageHandler,
) (*resolvedProfileConnection, error) {
	visited := map[string]bool{}
	node, err := buildResolvedNode(profile, profiles, vault, encryptor, visited, 0, onStage)
	if err != nil {
		return nil, err
	}
	if err := verifyResolvedNode(ctx, node, onMismatch, onStage); err != nil {
		return nil, err
	}
	return &resolvedProfileConnection{root: node, profiles: profiles}, nil
}

func buildResolvedNode(
	profile *model.Profile,
	profiles store.ProfileStore,
	vault store.VaultStore,
	encryptor *crypto.Encryptor,
	visited map[string]bool,
	depth int,
	onStage connectionStageHandler,
) (*resolvedProfileNode, error) {
	if profile == nil {
		return nil, fmt.Errorf("连接 Profile 不存在")
	}
	if depth > maxJumpProfiles {
		return nil, fmt.Errorf("SSH 跳板链最多允许 %d 层", maxJumpProfiles)
	}
	if visited[profile.ID] {
		return nil, fmt.Errorf("SSH 跳板链存在循环引用，重复节点: %s", profile.Name)
	}
	visited[profile.ID] = true
	defer delete(visited, profile.ID)

	if onStage != nil {
		onStage(model.ProfileTestStage{Stage: "resolve", Status: "success", ProfileID: profile.ID, ProfileName: profile.Name, Message: "已解析连接与凭据"})
	}
	cred, err := resolveProfileCredential(profile, vault, encryptor)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 的 SSH 凭据: %w", profile.Name, err)
	}
	node := &resolvedProfileNode{profile: profile}
	node.opts = protocol.DriverOpts{
		Host:               profile.Host,
		Port:               profile.Port,
		Username:           profile.Username,
		Password:           cred.Password,
		PrivKey:            cred.PrivKey,
		Passphrase:         cred.Passphrase,
		HostKeyFingerprint: profileHostKeyFingerprint(profile.Options),
	}

	switch profile.Proxy.Type {
	case "", model.ProxyTypeDirect:
	case model.ProxyTypeSOCKS5, model.ProxyTypeHTTP:
		password, err := decodeProxyPassword(profile.ProxyCredential, encryptor)
		if err != nil {
			return nil, fmt.Errorf("读取 %s 的代理凭据: %w", profile.Name, err)
		}
		node.opts.Proxy = &protocol.ProxyOpts{
			Type: profile.Proxy.Type, Host: profile.Proxy.Host, Port: profile.Proxy.Port,
			Username: profile.Proxy.Username, Password: password,
		}
		if onStage != nil {
			onStage(model.ProfileTestStage{Stage: "proxy", Status: "success", ProfileID: profile.ID, ProfileName: profile.Name, Message: strings.ToUpper(profile.Proxy.Type) + " 代理配置已就绪"})
		}
	case model.ProxyTypeJump:
		jumpProfile, err := profiles.Get(profile.Proxy.JumpProfileID)
		if err != nil {
			return nil, fmt.Errorf("%s 引用的跳板机不存在", profile.Name)
		}
		jump, err := buildResolvedNode(jumpProfile, profiles, vault, encryptor, visited, depth+1, onStage)
		if err != nil {
			return nil, err
		}
		node.jump = jump
		node.opts.JumpHost = &jump.opts
		if onStage != nil {
			onStage(model.ProfileTestStage{Stage: "proxy", Status: "success", ProfileID: jumpProfile.ID, ProfileName: jumpProfile.Name, Message: "将通过 SSH 跳板机连接"})
		}
	default:
		return nil, fmt.Errorf("%s 配置了未知代理类型 %s", profile.Name, profile.Proxy.Type)
	}

	routeMaterial := fmt.Sprintf("%s|%s|%d|%s|%s|%s|%s|%s|%s|%d|%s|%s",
		profile.ID, profile.Host, profile.Port, profile.Username, profile.AuthType,
		cred.Password, cred.PrivKey, cred.Passphrase,
		profile.Proxy.Type, profile.Proxy.Port, profile.Proxy.Host,
		profile.Proxy.Username+"|"+profile.Proxy.JumpProfileID+"|"+profile.ProxyCredential)
	if node.jump != nil {
		routeMaterial += "|" + node.jump.opts.PoolKey
	}
	sum := sha256.Sum256([]byte(routeMaterial))
	node.opts.PoolKey = profile.ID + ":" + hex.EncodeToString(sum[:8])
	return node, nil
}

func verifyResolvedNode(ctx context.Context, node *resolvedProfileNode, onMismatch hostKeyMismatchHandler, onStage connectionStageHandler) error {
	if node.jump != nil {
		if err := verifyResolvedNode(ctx, node.jump, onMismatch, onStage); err != nil {
			return err
		}
		node.opts.JumpHost = &node.jump.opts
	}
	current, err := sshproto.InspectHostKeyFingerprint(ctx, node.opts)
	if err != nil {
		return fmt.Errorf("检查 %s 的 SSH 主机指纹: %w", node.profile.Name, err)
	}
	known := profileHostKeyFingerprint(node.profile.Options)
	status := "success"
	message := "SSH 主机指纹校验通过"
	if known != "" && known != current {
		status = "error"
		message = "SSH 主机指纹已变化"
		if onStage != nil {
			onStage(model.ProfileTestStage{Stage: "host_key", Status: status, ProfileID: node.profile.ID, ProfileName: node.profile.Name, Message: message, KnownFingerprint: known, Fingerprint: current})
		}
		if onMismatch == nil || !onMismatch(node.profile, current, known) {
			return &HostKeyChangedError{ProfileID: node.profile.ID, ProfileName: node.profile.Name, Known: known, Current: current}
		}
		message = "新的 SSH 主机指纹已确认"
	}
	node.currentFingerprint = current
	node.opts.HostKeyFingerprint = current
	if onStage != nil && status != "error" {
		onStage(model.ProfileTestStage{Stage: "host_key", Status: "success", ProfileID: node.profile.ID, ProfileName: node.profile.Name, Message: message, KnownFingerprint: known, Fingerprint: current})
	}
	return nil
}

func (r *resolvedProfileConnection) Opts() protocol.DriverOpts { return r.root.opts }

func (r *resolvedProfileConnection) PersistHostKeys() {
	var persist func(*resolvedProfileNode)
	persist = func(node *resolvedProfileNode) {
		if node.jump != nil {
			persist(node.jump)
		}
		if node.profile.ID == "" || node.currentFingerprint == "" || profileHostKeyFingerprint(node.profile.Options) == node.currentFingerprint {
			return
		}
		options, err := withProfileHostKeyFingerprint(node.profile.Options, node.currentFingerprint)
		if err == nil {
			_ = r.profiles.Update(node.profile.ID, &model.ProfileUpdateRequest{Options: &options})
		}
	}
	persist(r.root)
}
