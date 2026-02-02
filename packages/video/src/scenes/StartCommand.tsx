import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { Terminal } from "../components/Terminal";
import { CommandPrompt } from "../components/CommandPrompt";
import { CommandOutput } from "../components/CommandOutput";
import { COLORS } from "../styles/colors";

export const StartCommand: React.FC = () => {
  const frame = useCurrentFrame();

  const commandTypingComplete = frame > 60;
  const outputStartFrame = 75;

  const headerOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: "clamp",
  });

  const footerOpacity = interpolate(frame, [100, 120], [0, 1], {
    extrapolateRight: "clamp",
  });

  // 実際のvibe startの出力形式に合わせる
  // cdコマンドは表示されず、自動的にworktreeに移動する
  const outputLines = [
    { text: "", delay: 0 },
    { text: "✶ Setting up worktree feat/new-ui…", color: COLORS.accent },
    { text: "┗ ☒ Pre-start hooks", color: COLORS.textMuted, delay: 20 },
    { text: "   ┗ ☒ pnpm install", color: COLORS.textMuted, delay: 35 },
    { text: "  ☒ Copying files", color: COLORS.textMuted, delay: 50 },
    { text: "   ┗ ☒ .env.local", color: COLORS.textMuted, delay: 60 },
    // CoW clonefile を強調
    { text: "  ☒ Copying directories (clonefile)", color: COLORS.info, delay: 75 },
    { text: "   ┗ ☒ node_modules/", color: COLORS.textMuted, delay: 90 },
    { text: "     ☒ .pnpm-store/", color: COLORS.textMuted, delay: 100 },
    { text: "", delay: 115 },
  ];

  // 親ディレクトリにvibe-feat-new-uiができて自動でcd
  const showNewPrompt = frame > outputStartFrame + 130;

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
        vibe start
      </div>
      <div
        style={{
          fontSize: 24,
          color: COLORS.textMuted,
        }}
      >
        super fast ⚡ automatic setup
      </div>
    </div>
  );

  const footer = (
    <div style={{ opacity: footerOpacity, textAlign: "center" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 40 }}>⚡</span>
        <span
          style={{
            fontSize: 28,
            fontWeight: 600,
            color: COLORS.info,
          }}
        >
          Copy-on-Write
        </span>
      </div>
      <div
        style={{
          fontSize: 20,
          color: COLORS.textMuted,
          lineHeight: 1.6,
        }}
      >
        node_modules cloning — super fast
        <br />
        <span style={{ color: COLORS.text }}>APFS / Btrfs / XFS</span>
      </div>
    </div>
  );

  return (
    <Terminal title="vibe start — Terminal" header={header} footer={footer}>
      {/* Command */}
      <CommandPrompt
        command="vibe start feat/new-ui"
        startFrame={15}
        typeSpeed={2}
        showCursor={!commandTypingComplete}
      />

      {/* Output */}
      {commandTypingComplete && (
        <CommandOutput lines={outputLines} startFrame={outputStartFrame} lineDelay={3} />
      )}

      {/* New prompt after moving to worktree */}
      {showNewPrompt && (
        <div style={{ marginTop: 8 }}>
          <span style={{ color: COLORS.promptPath }}>~/ghq/github.com/kexi/vibe-feat-new-ui</span>
          <span style={{ color: COLORS.promptSymbol }}> ❯ </span>
          <span style={{ color: COLORS.cursor }}>▋</span>
        </div>
      )}
    </Terminal>
  );
};
