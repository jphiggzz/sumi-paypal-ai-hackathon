import { Suspense } from "react";
import Workspace from "./workspace";
import type { Metadata } from "next";
import { headers } from "next/headers";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ giftInvite?: string; snackInvite?: string }> }): Promise<Metadata> {
  const { giftInvite, snackInvite } = await searchParams;
  if (snackInvite && /^[A-Za-z0-9_-]{43}$/.test(snackInvite)) return { title: "Join office snacks · Sume", description: "Join your office on Sume." };
  if (!giftInvite || !/^[A-Za-z0-9_-]{43}$/.test(giftInvite)) return {};
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const safeHost = /^[a-zA-Z0-9.:[\]-]+$/.test(host) ? host : "localhost:3000";
  const protocol = /^(localhost|127\.0\.0\.1)(:|$)/.test(safeHost) ? "http" : "https";
  const image = `${protocol}://${safeHost}/gift-invite-image`;
  return {
    title: "Join a group gift · Sume",
    description: "Join your friends’ group gift on Sume.",
    openGraph: { title: "Join a group gift · Sume", description: "Join your friends’ group gift on Sume.", images: [{ url: image, width: 1200, height: 630 }], type: "website" },
    twitter: { card: "summary_large_image", title: "Join a group gift · Sume", description: "Join your friends’ group gift on Sume.", images: [image] },
  };
}
export default function Page() {
  return (
    <Suspense>
      <Workspace />
    </Suspense>
  );
}
