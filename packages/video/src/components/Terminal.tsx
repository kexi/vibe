import React from "react";
import { COLORS } from "../styles/colors";

interface TerminalProps {
  children: React.ReactNode;
  title?: string;
  // 縦動画用: 上部ヘッダー
  header?: React.ReactNode;
  // 縦動画用: 下部フッター
  footer?: React.ReactNode;
}

export const Terminal: React.FC<TerminalProps> = ({
  children,
  title = "Terminal",
  header,
  footer,
}) => {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#0a0a0f",
        display: "flex",
        flexDirection: "column",
        fontFamily: "SF Mono, Menlo, Monaco, monospace",
      }}
    >
      {/* Header Area - 上部 */}
      {header && (
        <div
          style={{
            padding: "60px 40px 30px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {header}
        </div>
      )}

      {/* Terminal Area - 中央（横長を維持） */}
      <div
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "0 40px",
        }}
      >
        <div
          style={{
            width: "100%",
            maxHeight: 600,
            height: "auto",
            minHeight: 400,
            backgroundColor: COLORS.background,
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Title Bar */}
          <div
            style={{
              height: 40,
              backgroundColor: COLORS.titleBar,
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              gap: 8,
              flexShrink: 0,
            }}
          >
            {/* Window buttons */}
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: COLORS.titleBarButton.close,
              }}
            />
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: COLORS.titleBarButton.minimize,
              }}
            />
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                backgroundColor: COLORS.titleBarButton.maximize,
              }}
            />
            {/* Title */}
            <div
              style={{
                flex: 1,
                textAlign: "center",
                color: COLORS.textMuted,
                fontSize: 14,
              }}
            >
              {title}
            </div>
            {/* Spacer for buttons */}
            <div style={{ width: 60 }} />
          </div>
          {/* Terminal Content */}
          <div
            style={{
              flex: 1,
              padding: 24,
              fontSize: 16,
              lineHeight: 1.6,
              color: COLORS.text,
              overflow: "hidden",
            }}
          >
            {children}
          </div>
        </div>
      </div>

      {/* Footer Area - 下部 */}
      {footer && (
        <div
          style={{
            padding: "30px 40px 60px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
};
