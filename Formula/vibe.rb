class Vibe < Formula
  desc "Git worktree helper CLI"
  homepage "https://github.com/kexi/vibe"
  version "VERSION_PLACEHOLDER"
  license "MIT"

  conflicts_with "vibe-beta", because: "both install the same binary"

  on_macos do
    on_arm do
      url "https://github.com/kexi/vibe/releases/download/vVERSION_PLACEHOLDER/vibe-darwin-arm64"
      sha256 "SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/kexi/vibe/releases/download/vVERSION_PLACEHOLDER/vibe-darwin-x64"
      sha256 "SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/kexi/vibe/releases/download/vVERSION_PLACEHOLDER/vibe-linux-arm64"
      sha256 "SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/kexi/vibe/releases/download/vVERSION_PLACEHOLDER/vibe-linux-x64"
      sha256 "SHA256_LINUX_X64"
    end
  end

  def install
    binary_name = "vibe-darwin-arm64" if OS.mac? && Hardware::CPU.arm?
    binary_name = "vibe-darwin-x64" if OS.mac? && Hardware::CPU.intel?
    binary_name = "vibe-linux-arm64" if OS.linux? && Hardware::CPU.arm?
    binary_name = "vibe-linux-x64" if OS.linux? && Hardware::CPU.intel?

    bin.install binary_name => "vibe"
  end

  def caveats
    <<~EOS
      Add this to your .zshrc:
        vibe() { eval "$(command vibe "$@")" }
    EOS
  end

  test do
    system "#{bin}/vibe", "--help"
  end
end
