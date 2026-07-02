package handler

import (
	"fmt"

	"github.com/yuweinfo/xcontrol/crypto"
	"github.com/yuweinfo/xcontrol/model"
	"github.com/yuweinfo/xcontrol/store"
)

func resolveProfileCredential(profile *model.Profile, vault store.VaultStore, encryptor *crypto.Encryptor) (*model.Credential, error) {
	if profile == nil {
		return &model.Credential{}, nil
	}

	// Vault only provides secret material (password / private key / certificate).
	// The effective login username always comes from profile.Username so a server
	// can override the optional username metadata stored on the Vault item.
	if profile.AuthType == "vault" && profile.VaultID != "" {
		cred, err := vault.Retrieve(profile.VaultID)
		if err != nil {
			return nil, fmt.Errorf("retrieve vault credential: %w", err)
		}
		return cred, nil
	}

	if profile.InlineCredential != "" {
		cred, err := store.DecodeInlineCredential(encryptor, profile.InlineCredential)
		if err != nil {
			return nil, fmt.Errorf("decode inline credential: %w", err)
		}
		return cred, nil
	}

	// Legacy fallback: if a non-vault profile still has a vault ID before the
	// migration runs, keep the connection working.
	if profile.VaultID != "" {
		cred, err := vault.Retrieve(profile.VaultID)
		if err != nil {
			return nil, fmt.Errorf("retrieve legacy vault credential: %w", err)
		}
		return cred, nil
	}

	return &model.Credential{}, nil
}
