package protocol

import (
	"fmt"
	"sync"
)

type Manager struct {
	factories map[string]DriverFactory
	mu        sync.RWMutex
}

type DriverFactory func(opts DriverOpts) (Driver, error)

type DriverOpts struct {
	Host       string
	Port       int
	Username   string
	Password   string
	PrivKey    string
	Passphrase string
	JumpHost   *DriverOpts // optional jump host
}

func NewManager() *Manager {
	return &Manager{
		factories: make(map[string]DriverFactory),
	}
}

func (m *Manager) Register(protocol string, factory DriverFactory) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.factories[protocol] = factory
}

func (m *Manager) Create(protocol string, opts DriverOpts) (Driver, error) {
	m.mu.RLock()
	factory, ok := m.factories[protocol]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unsupported protocol: %s", protocol)
	}
	return factory(opts)
}
