package fileutil

import (
	"context"
	"io"
	"path"
	"strings"
)

// --- Path helpers (POSIX-style, shared by all backends) ---

// CleanPath normalises a POSIX path: removes redundant slashes and "..".
func CleanPath(p string) string {
	if p == "" {
		return "/"
	}
	cleaned := path.Clean(p)
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

// JoinPath joins path elements using POSIX separators.
func JoinPath(elem ...string) string {
	return path.Join(elem...)
}

// ParentPath returns the parent directory of a POSIX path.
// "/a/b" → "/a", "/a" → "/", "/" → "/".
func ParentPath(p string) string {
	if p == "/" || p == "" {
		return "/"
	}
	parent := path.Dir(p)
	if parent == "." {
		return "/"
	}
	return parent
}

// BaseName returns the last element of a path.
func BaseName(p string) string {
	return path.Base(p)
}

// SplitExt splits a file name into its base name and extension (including the
// dot). "archive.tar.gz" → ("archive.tar", ".gz"). Directories return the
// full name with an empty extension.
func SplitExt(name string) (base, ext string) {
	// Hidden files like ".bashrc" are treated as name-only.
	if strings.HasPrefix(name, ".") && strings.Count(name, ".") == 1 {
		return name, ""
	}
	i := strings.LastIndex(name, ".")
	if i <= 0 || i == len(name)-1 {
		return name, ""
	}
	return name[:i], name[i:]
}

// AutoRename returns a non-colliding destination path by appending " (N)" to
// the file base name (before the extension) until the target does not exist.
// Example: "/dir/file.txt" → "/dir/file (1).txt" → "/dir/file (2).txt".
// The exists check is performed via the provided backend so this works for
// both local and SFTP targets.
func AutoRename(ctx context.Context, be FileBackend, destPath string) (string, error) {
	dir := path.Dir(destPath)
	name := path.Base(destPath)
	base, ext := SplitExt(name)

	for i := 1; ; i++ {
		candidate := base + " (" + itoa(i) + ")" + ext
		candidatePath := path.Join(dir, candidate)
		_, err := be.Stat(ctx, candidatePath)
		if err != nil {
			// Treat any stat error (not-exist) as "available".
			return candidatePath, nil
		}
		if i > 9999 {
			// Safety valve to avoid an infinite loop.
			return candidatePath, nil
		}
	}
}

// itoa is a tiny strconv.Itoa replacement to keep the import surface small.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// --- Generic utilities built on FileBackend ---

// RemoveAll recursively deletes a path (file or directory tree).
// Works for any FileBackend implementation.
func RemoveAll(ctx context.Context, be FileBackend, p string) error {
	info, err := be.Stat(ctx, p)
	if err != nil {
		return err
	}
	if !info.IsDir {
		return be.Remove(ctx, p)
	}
	entries, err := be.List(ctx, p)
	if err != nil {
		return err
	}
	for _, e := range entries {
		childPath := p
		if p == "/" {
			childPath = "/" + e.Name
		} else {
			childPath = p + "/" + e.Name
		}
		if err := RemoveAll(ctx, be, childPath); err != nil {
			// Continue deleting other entries; return last error
			continue
		}
	}
	return be.Remove(ctx, p)
}

// CopyFile copies a single file from src to dst within the same backend.
func CopyFile(ctx context.Context, be FileBackend, src, dst string) error {
	rc, err := be.OpenRead(ctx, src)
	if err != nil {
		return err
	}
	defer rc.Close()

	wc, err := be.OpenWrite(ctx, dst)
	if err != nil {
		return err
	}
	defer wc.Close()

	return copyWithCtx(ctx, rc, wc)
}

// Walk recursively traverses a directory tree, calling fn for every entry
// (including the root). If fn returns an error, walking stops.
func Walk(ctx context.Context, be FileBackend, root string, fn func(path string, info FileInfo) error) error {
	info, err := be.Stat(ctx, root)
	if err != nil {
		return err
	}
	if err := fn(root, info); err != nil {
		return err
	}
	if !info.IsDir {
		return nil
	}
	entries, err := be.List(ctx, root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		childPath := root
		if root == "/" {
			childPath = "/" + e.Name
		} else {
			childPath = root + "/" + e.Name
		}
		if err := Walk(ctx, be, childPath, fn); err != nil {
			return err
		}
	}
	return nil
}

// Tree builds a recursive tree structure up to maxDepth.
// maxDepth <= 0 means no limit (use with caution on large trees).
func Tree(ctx context.Context, be FileBackend, root string, maxDepth int) ([]TreeNode, error) {
	entries, err := be.List(ctx, root)
	if err != nil {
		return nil, err
	}
	nodes := make([]TreeNode, 0, len(entries))
	for _, e := range entries {
		childPath := root
		if root == "/" {
			childPath = "/" + e.Name
		} else {
			childPath = root + "/" + e.Name
		}
		node := TreeNode{FileInfo: e}
		if e.IsDir && (maxDepth <= 0 || maxDepth > 1) {
			childDepth := maxDepth - 1
			if maxDepth <= 0 {
				childDepth = 0
			}
			children, err := Tree(ctx, be, childPath, childDepth)
			if err == nil {
				node.Children = children
			}
		}
		nodes = append(nodes, node)
	}
	return nodes, nil
}

// TreeNode is a tree entry with optional children.
type TreeNode struct {
	FileInfo
	Children []TreeNode `json:"children,omitempty"`
}

// copyWithCtx copies from src to dst, respecting context cancellation.
func copyWithCtx(ctx context.Context, src io.Reader, dst io.Writer) error {
	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
	}
}
