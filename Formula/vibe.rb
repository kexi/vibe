class Vibe < Formula
  desc "Git worktree helper CLI"
  homepage "https://github.com/YOUR_USERNAME/vibe"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/YOUR_USERNAME/vibe/releases/download/v#{version}/vibe-darwin-arm64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
    on_intel do
      url "https://github.com/YOUR_USERNAME/vibe/releases/download/v#{version}/vibe-darwin-x64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/YOUR_USERNAME/vibe/releases/download/v#{version}/vibe-linux-arm64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256"
    end
    on_intel do
      url "https://github.com/YOUR_USERNAME/vibe/releases/download/v#{version}/vibe-linux-x64"
      sha256 "REPLACE_WITH_ACTUAL_SHA256"
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
