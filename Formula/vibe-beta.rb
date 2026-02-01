class VibeBeta < Formula
  desc "Git worktree helper CLI (beta channel)"
  homepage "https://github.com/kexi/vibe"
  version "VERSION_PLACEHOLDER"
  license "MIT"


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

    bin.install binary_name => "vibe-beta"
  end

  def caveats
    <<~EOS
      ⚠️  This is a BETA version installed from the develop branch.
      It may contain unstable features. For the stable release, use:
        brew install kexi/tap/vibe

      Add this to your .zshrc:
        vibe-beta() { eval "$(command vibe-beta "$@")" }
    EOS
  end

  test do
    system "#{bin}/vibe-beta", "--help"
  end
end
