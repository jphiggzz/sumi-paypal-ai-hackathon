import type { ReactNode } from "react";
import "./style.css";

export const metadata = { title: "Sume Campaigns" };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-frame">{children}</div>
      </body>
    </html>
  );
}
