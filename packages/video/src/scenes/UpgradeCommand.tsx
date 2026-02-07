import React from "react";
import { useCurrentFrame } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const UpgradeCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 45;
  const outputStartFrame = 60;

  // 実際のvibe upgradeの出力形式に合わせる
  const outputLines = [
    { text: "", delay: 0 },
    { text: "vibe 0.12.7+a6c3c77", color: COLORS.text },
    { text: "", delay: 6 },
    { text: "A new version is available: 0.13.0", color: COLORS.success, delay: 12 },
    { text: "", delay: 18 },
    { text: "To upgrade:", color: COLORS.text, delay: 24 },
    { text: "  brew upgrade kexi/tap/vibe", color: COLORS.info, delay: 30 },
    { text: "", delay: 36 },
    { text: "Release notes:", color: COLORS.text, delay: 42 },
    { text: "  https://github.com/kexi/vibe/releases/tag/v0.13.0", color: COLORS.info, delay: 48 },
  ];

  return (
    <Terminal title="vibe upgrade — Terminal">
      {/* Title */}
      <div
        style={{
          color: COLORS.accent,
          fontSize: 24,
          marginBottom: 16,
          fontWeight: 600,
        }}
      >
        vibe upgrade
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          marginBottom: 24,
          fontSize: 16,
        }}
      >
        Check for new version and show upgrade instructions
      </div>

      {/* Command */}
      <CommandPrompt
        command="vibe upgrade"
        startFrame={15}
        typeSpeed={2}
        showCursor={!commandTypingComplete}
      />

      {/* Output */}
      {commandTypingComplete && (
        <CommandOutput lines={outputLines} startFrame={outputStartFrame} lineDelay={3} />
      )}
    </Terminal>
  );
};
