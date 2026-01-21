import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const CleanCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 45;
  const outputStartFrame = 60;

  const headerOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  const footerOpacity = interpolate(frame, [80, 100], [0, 1], {
    extrapolateRight: "clamp",
  });

  // 実際のvibe cleanの出力形式に合わせる
  // cdコマンドは表示されず、自動的にmain worktreeに移動する
  const outputLines = [
    { text: "", delay: 0 },
    { text: "Worktree /Users/kei/worktrees/vibe-feat-new-ui has been removed.", color: COLORS.text },
    { text: "", delay: 15 },
  ];

  const showNewPrompt = frame > outputStartFrame + 30;

  const header = (
    <div style={{ opacity: headerOpacity, textAlign: "center" }}>
      <div
        style={{
          fontSize: 64,
          fontWeight: 700,
          color: COLORS.accent,
          marginBottom: 16,
        }}
      >
        vibe clean
      </div>
      <div
        style={{
          fontSize: 24,
          color: COLORS.textMuted,
        }}
      >
        Remove worktree and return to main repo
      </div>
    </div>
  );

  const footer = (
    <div style={{ opacity: footerOpacity, textAlign: "center" }}>
      <div
        style={{
          fontSize: 22,
          color: COLORS.textMuted,
          lineHeight: 1.6,
        }}
      >
        <span style={{ color: COLORS.success }}>✓</span> Worktree removed
        <br />
        <span style={{ color: COLORS.success }}>✓</span> Auto-navigate to main repo
      </div>
    </div>
  );

  return (
    <Terminal title="vibe clean — Terminal" header={header} footer={footer}>
      {/* Command */}
      <CommandPrompt
        command="vibe clean"
        startFrame={15}
        typeSpeed={2}
        showCursor={!commandTypingComplete}
        promptPath="~/worktrees/vibe-feat-new-ui"
      />

      {/* Output */}
      {commandTypingComplete && (
        <CommandOutput
          lines={outputLines}
          startFrame={outputStartFrame}
          lineDelay={3}
        />
      )}

      {/* New prompt after moving to main repo */}
      {showNewPrompt && (
        <div style={{ marginTop: 8 }}>
          <span style={{ color: COLORS.promptPath }}>~/ghq/github.com/kexi/vibe</span>
          <span style={{ color: COLORS.promptSymbol }}> ❯ </span>
          <span style={{ color: COLORS.cursor }}>▋</span>
        </div>
      )}
    </Terminal>
  );
};
