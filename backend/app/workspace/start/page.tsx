"use client";
import { useState, useEffect, useRef } from "react";
import { ArrowRight, Check, Gift, Megaphone, Package } from "lucide-react";
import { Button } from "../_components/ui/button";
import base from "./onboarding-base.module.css";
import ui from "./onboarding.module.css";
import { referenceMotion, useReferenceReducedMotion } from "./motion";
export default function Start() {
  const [mode, setMode] = useState("creators");
  const [leaving, setLeaving] = useState(false);
  const reduced = useReferenceReducedMotion();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <main
      data-handoff={leaving ? "leaving" : "idle"}
      data-unified-workspace
      className={`${base.reference} ${ui.app}`}
    >
      <header className={ui.header}>
        <a href="/workspace/landing" className={ui.wordmark}>
          sume
        </a>
      </header>
      <div className={ui.stage} inert={leaving}>
        <section className={`${base.reasonScreen} ${ui.choose}`}>
          <h1>What are you working on?</h1>
          <div className={base.reasons} role="group" aria-label="Choose a mode">
            {[
              { id: "creators", label: "Creator campaigns", Icon: Megaphone },
              { id: "gifts", label: "Group gifts", Icon: Gift },
              { id: "snacks", label: "Office shopping", Icon: Package },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                className={base.reason}
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
              >
                <Icon size={21} strokeWidth={1.6} />
                <span>{label}</span>
                {mode === id && (
                  <span className={base.check}>
                    <Check size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className={base.actions}>
            <Button asChild className={ui.continue}>
              <a
                href={mode === "creators" ? "/workspace?mode=creators" : `/workspace?mode=shopping&start=${mode}`}
                onClick={(e) => {
                  e.preventDefault();
                  if (leaving) return;
                  setLeaving(true);
                  timer.current = setTimeout(
                    () => {
                      location.href = mode === "creators" ? "/workspace?mode=creators" : `/workspace?mode=shopping&start=${mode}`;
                    },
                    reduced ? 0 : referenceMotion.stepExitDuration,
                  );
                }}
              >
                Continue
                <ArrowRight size={15} />
              </a>
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
