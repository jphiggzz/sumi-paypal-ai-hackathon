import { ImageResponse } from "next/og";

export function GET() {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#f3f3ef", color: "#191919", padding: "72px", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: -3 }}>sume</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: -3 }}>You’re invited</div>
        <div style={{ fontSize: 32, color: "#696965" }}>Join a group gift on Sume</div>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
