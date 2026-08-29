package handler

import (
	"fmt"
	"strings"

	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

const maxJumpProfiles = 5

func normalizeProxyInput(input *model.ProxyInput) (model.ProxyConfig, error) {
	if input == nil || input.Type == "" || input.Type == model.ProxyTypeDirect {
		return model.DirectProxyConfig(), nil
	}

	proxy := model.ProxyConfig{
		Type:          strings.TrimSpace(input.Type),
		Host:          strings.TrimSpace(input.Host),
		Port:          input.Port,
		Username:      strings.TrimSpace(input.Username),
		JumpProfileID: strings.TrimSpace(input.JumpProfileID),
	}
	switch proxy.Type {
	case model.ProxyTypeSOCKS5, model.ProxyTypeHTTP:
		if proxy.Host == "" {
			return proxy, fmt.Errorf("代理主机不能为空")
		}
		if proxy.Port == 0 {
			if proxy.Type == model.ProxyTypeSOCKS5 {
				proxy.Port = 1080
			} else {
				proxy.Port = 8080
			}
		}
		if proxy.Port < 1 || proxy.Port > 65535 {
			return proxy, fmt.Errorf("代理端口必须在 1 到 65535 之间")
		}
		if input.Password != nil && *input.Password != "" && proxy.Username == "" {
			return proxy, fmt.Errorf("填写代理密码时必须同时填写用户名")
		}
	case model.ProxyTypeJump:
		if proxy.JumpProfileID == "" {
			return proxy, fmt.Errorf("请选择 SSH 跳板机")
		}
		proxy.Host = ""
		proxy.Port = 0
		proxy.Username = ""
	default:
		return proxy, fmt.Errorf("不支持的代理类型: %s", proxy.Type)
	}
	return proxy, nil
}

func encodeProxyPassword(password string, encryptor interface {
	Encrypt(string) (string, error)
}) (string, error) {
	if password == "" {
		return "", nil
	}
	encoded, err := encryptor.Encrypt(password)
	if err != nil {
		return "", fmt.Errorf("加密代理密码: %w", err)
	}
	return encoded, nil
}

func decodeProxyPassword(encoded string, decryptor interface {
	Decrypt(string) (string, error)
}) (string, error) {
	if encoded == "" {
		return "", nil
	}
	password, err := decryptor.Decrypt(encoded)
	if err != nil {
		return "", fmt.Errorf("解密代理密码: %w", err)
	}
	return password, nil
}

func sameProxyIdentity(a, b model.ProxyConfig) bool {
	return a.Type == b.Type && a.Host == b.Host && a.Port == b.Port &&
		a.Username == b.Username && a.JumpProfileID == b.JumpProfileID
}

func validateProxyChain(profiles store.ProfileStore, rootID string, rootProxy model.ProxyConfig) error {
	visited := map[string]bool{rootID: true}
	path := []string{rootID}
	proxy := rootProxy
	for depth := 0; proxy.Type == model.ProxyTypeJump; depth++ {
		if depth >= maxJumpProfiles {
			return fmt.Errorf("SSH 跳板链最多允许 %d 层", maxJumpProfiles)
		}
		nextID := proxy.JumpProfileID
		if visited[nextID] {
			path = append(path, nextID)
			return fmt.Errorf("SSH 跳板链存在循环引用: %s", strings.Join(path, " -> "))
		}
		next, err := profiles.Get(nextID)
		if err != nil {
			return fmt.Errorf("跳板机 Profile 不存在: %s", nextID)
		}
		visited[nextID] = true
		path = append(path, nextID)
		proxy = next.Proxy
	}
	return nil
}
