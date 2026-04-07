class VibeATCLASSNAME_PLACEHOLDER < Formula
  desc "Git worktree helper CLI (versioned)"
  homepage "https://github.com/kexi/vibe"
  version "VERSION_PLACEHOLDER"
  license "MIT"
  keg_only :versioned_formula

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
    binary_name = if OS.mac? && Hardware::CPU.arm?
      "vibe-darwin-arm64"
    elsif OS.mac? && Hardware::CPU.intel?
      "vibe-darwin-x64"
    elsif OS.linux? && Hardware::CPU.arm?
      "vibe-linux-arm64"
    elsif OS.linux? && Hardware::CPU.intel?
      "vibe-linux-x64"
    else
      odie "Unsupported platform"
    end

    bin.install binary_name => "vibe"
  end

  test do
    system "#{bin}/vibe", "--help"
  end
end
