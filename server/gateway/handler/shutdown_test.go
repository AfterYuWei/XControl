package handler

import (
	"testing"
	"time"
)

func TestTransferManagerShutdownIsPromptAndIdempotent(t *testing.T) {
	manager := NewTransferManager(nil)
	done := make(chan struct{})
	go func() {
		manager.Shutdown()
		manager.Shutdown()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("transfer manager shutdown timed out")
	}
}
