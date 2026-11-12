import { Manrope } from "next/font/google";
import "./workspace.css";
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
export const metadata = {
  title: "Sume",
  icons: { icon: "/workspace-assets/bot/favicon.svg" },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div data-workspace-root className={`workspace-theme ${manrope.variable}`}>
      {children}
    </div>
  );
}
