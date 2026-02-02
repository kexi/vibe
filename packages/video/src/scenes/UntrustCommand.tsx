import React from "react";
import { useCurrentFrame } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const UntrustCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 40;
  const outputStartFrame = 55;

  // 実際のvibe untrustの出力形式に合わせる
  const outputLines = [
    { text: "", delay: 0 },
    { text: "Untrusted: ~/ghq/github.com/kexi/vibe/.vibe.toml", color: COLORS.text },
    { text: "Settings: ~/.config/vibe/settings.json", color: COLORS.textMuted, delay: 6 },
  ];

  return (
    <Terminal title="vibe untrust — Terminal">
      {/* Title */}
      <div
        style={{
          color: COLORS.accent,
          fontSize: 24,
          marginBottom: 16,
          fontWeight: 600,
        }}
      >
        vibe untrust
      </div>
      <div
        style={{
          color: COLORS.textMuted,
          marginBottom: 24,
          fontSize: 16,
        }}
      >
        Remove config from trusted list
      </div>

      {/* Command */}
      <CommandPrompt
        command="vibe untrust"
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
