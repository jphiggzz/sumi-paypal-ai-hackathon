import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot } from "lucide-react";
import styles from "./workspace-home.module.css";
import { Mascot } from "./agent-avatar";

type Story = {
  id: string;
  label: string;
  mode: "creators" | "shopping";
  draft?: string;
  preview: "creator" | "gift" | "shopping";
};

// Add stories here; the gallery handles incomplete rows at every breakpoint.
const stories: Story[] = [
  { id: "creators", label: "Creator campaigns", mode: "creators", preview: "creator" },
  { id: "gifts", label: "Group gifts", mode: "shopping", draft: "Plan a group thank-you gift", preview: "gift" },
  { id: "snacks", label: "Office shopping", mode: "shopping", draft: "Plan monthly office snacks", preview: "shopping" },
];

const creatorClips = ["8134919", "8136213", "8135999", "3860469", "7677560", "8135642", "8993486"];

function CreatorPreview() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const clips = Array.from(root.querySelectorAll("video"));
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const sync = () => {
      const playing = !motion.matches && visible && !document.hidden;
      root.dataset.playing = String(playing);
      if (!playing) clips.forEach((clip) => clip.pause());
      else clips.forEach((clip) => { void clip.play().catch(() => {}); });
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0.15 });
    observer.observe(root);
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); motion.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync); clips.forEach((clip) => clip.pause()); };
  }, []);
  return <div ref={container} data-playing="false" aria-hidden="true" className={`${styles.preview} ${styles.creator}`}><div className={styles.creatorClips}>{creatorClips.map((id) => <video key={id} className={styles.creatorClip} muted loop playsInline preload="none" poster={`/workspace-home/creator-${id}.jpg`}><source src={`/workspace-home/creator-${id}.mp4`} type="video/mp4" /></video>)}</div></div>;
}

const officeMessages = ["Diet Coke and jerky", "Cashews and gummy bears", "Vitaminwater and chips"];
const people = ["a", "b", "c"];
const giftStepDurations = [1000, 1600, 2000, 1700, 2500, 2200, 3000, 3500];

function GiftBotPreview() {
  const container = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    let currentStep = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const advance = () => {
      currentStep = (currentStep + 1) % giftStepDurations.length;
      setStep(currentStep);
      timer = setTimeout(advance, giftStepDurations[currentStep]);
    };
    const sync = () => {
      clear();
      if (motion.matches) { currentStep = 3; setStep(3); return; }
      if (visible && !document.hidden) timer = setTimeout(advance, giftStepDurations[currentStep]);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0.15 });
    observer.observe(root);
    motion.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => { clear(); observer.disconnect(); motion.removeEventListener("change", sync); document.removeEventListener("visibilitychange", sync); };
  }, []);
  useEffect(() => {
    const el = track.current;
    const parent = container.current;
    if (!el || !parent) return;
    const update = () => { el.style.transform = `translateY(${Math.min(0, parent.clientHeight - 24 - el.scrollHeight)}px)`; };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [step]);
  return <div ref={container} aria-hidden="true" className={`${styles.preview} ${styles.giftBot}`}>
    <div ref={track} className={styles.giftTrack}>
      <div className={`${styles.giftEntry} ${styles.giftUser}`}><span>can our friends find Maya a thank-you gift? we have $300.</span></div>
      {step === 1 && <div className={styles.giftPending}><span className={styles.giftDots}><i /><i /><i /></span>Thinking</div>}
      {step >= 2 && <div className={`${styles.giftEntry} ${styles.giftAssistant}`}><span>i’ll bring everyone’s agents together to find something Maya would love within the group budget.</span></div>}
      {step >= 3 && <div className={styles.giftArtifact}><span>Started agent group</span><span><Bot size={13} /> Maya’s gift crew</span></div>}
      {step === 4 && <div className={styles.giftPending}><span className={styles.giftDots}><i /><i /><i /></span>Coordinating</div>}
      {step >= 5 && <div className={`${styles.giftEntry} ${styles.giftAssistant}`}><span>✓ <strong>Ideas</strong> → shared by friends<br />✓ <strong>Options</strong> → shortlisted<br />✓ <strong>Budget</strong> → within $300</span></div>}
      {step >= 6 && <div className={`${styles.giftEntry} ${styles.giftAssistant}`}><span>i found a few ideas for the group. does Maya prefer something cozy or an experience?</span></div>}
      {step >= 7 && <div className={`${styles.giftEntry} ${styles.giftUser}`}><span>something cozy sounds perfect</span></div>}
    </div>
  </div>;
}

function OfficePreview() {
  return <div aria-hidden="true" className={`${styles.preview} ${styles.conversation} ${styles.shopping}`}>
    <div className={styles.messages}>
      {officeMessages.map((message, index) => <div key={message} className={styles.message}>
        <img className={styles.person} src={`/workspace-home/person-${people[index]}.jpg`} alt="" />
        <span className={styles.employeeBot}><Bot size={12} /></span>
        <span className={styles.bubble}>{message}</span>
      </div>)}
      <div className={`${styles.message} ${styles.response}`}>
        <span className={styles.agent}><Mascot color="#82966f" small /></span>
        <span className={styles.bubble}>I’ll balance the basket within the office budget.</span>
      </div>
    </div>
  </div>;
}

function StoryPreview({ kind }: { kind: Story["preview"] }) {
  if (kind === "creator") return <CreatorPreview />;
  if (kind === "gift") return <GiftBotPreview />;
  return <OfficePreview />;
}

export default function WorkspaceHome({ onChoose }: { onChoose: (story: Pick<Story, "mode" | "draft">) => void }) {
  return <div className={styles.home}>
    <h1>What would you like to do?</h1>
    <div className={styles.grid}>
      {stories.map((story) => <button type="button" key={story.id} className={`${styles.tile} ${story.preview === "gift" ? styles.giftTile : ""}`} onClick={() => onChoose(story)}>
        <StoryPreview kind={story.preview} />
        <span className={styles.label}><span>{story.label}</span><span className={styles.labelAction} aria-hidden="true">Explore <ArrowRight /></span></span>
      </button>)}
    </div>
  </div>;
}
