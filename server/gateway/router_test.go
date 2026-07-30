package gateway

import (
	"sync/atomic"
	"testing"
)

func TestRuntimeCloseIsIdempotent(t *testing.T) {
	var calls atomic.Int32
	runtime := &Runtime{closeFn: func() {
		calls.Add(1)
	}}

	runtime.Close()
	runtime.Close()

	if got := calls.Load(); got != 1 {
		t.Fatalf("close calls = %d, want 1", got)
	}
}
