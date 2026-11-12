import { Check, ChevronLeft, Home, MessageSquare, Play, Plus } from 'lucide-react';
import styles from './creator-guide.module.css';

function PreviewShell({ children }: { children: React.ReactNode }) {
  return <div className={styles.preview} aria-hidden="true">
    <div className={styles.window}>
      <div className={styles.windowTitle}>sume</div>
      <div className={styles.windowBody}>
        <div className={styles.rail}><Home /><Plus /><MessageSquare /></div>
        <div className={styles.canvas}>{children}</div>
      </div>
    </div>
  </div>;
}

function BriefPreview() {
  return <PreviewShell>
    <div className={styles.chatBubble}>Plan a campaign for PayPal</div>
    <div className={styles.reply}>
      <strong>sume</strong>
      <p>Got it. To plan your campaign, a few quick details would help:</p>
      <div className={styles.checklist}>
        {['Campaign goal', 'Target audience', 'Budget range'].map((item, index) =>
          <div key={item}><span className={styles.check} style={{ animationDelay: `${index * .45}s` }}><Check /></span>{item}</div>)}
      </div>
    </div>
  </PreviewShell>;
}

function ReviewPreview() {
  return <PreviewShell>
    <div className={styles.previewHeading}><ChevronLeft />Review deliverable</div>
    <div className={styles.deliverable}>
      <div className={styles.creator}><img src="/workspace-home/person-a.jpg" alt="" /><span><strong>Creator deliverable</strong><small>2 videos</small></span></div>
      <div className={styles.video}><img src="/workspace-home/creator-8134919.jpg" alt="" /><span className={styles.play}><Play fill="currentColor" /></span></div>
    </div>
    <div className={styles.total}><span>Total</span><strong>$2,500</strong></div>
    <div className={styles.pay}><span className={styles.payPending}>Pay with PayPal</span><span className={styles.payComplete}>Payment complete</span></div>
  </PreviewShell>;
}

function LearnPreview() {
  return <PreviewShell>
    <div className={styles.chartHeading}>Metric trends</div>
    <div className={styles.chart}>
      <svg viewBox="0 0 220 125" role="presentation" preserveAspectRatio="none">
        <path className={`${styles.chartLine} ${styles.blue}`} d="M4 92 L25 84 L45 88 L65 73 L85 80 L105 75 L125 84 L145 71 L165 77 L185 58 L216 20" />
        <path className={`${styles.chartLine} ${styles.green}`} d="M4 105 L25 99 L45 96 L65 102 L85 91 L105 88 L125 96 L145 90 L165 86 L185 71 L216 44" />
        <path className={`${styles.chartLine} ${styles.orange}`} d="M4 116 L25 108 L45 111 L65 106 L85 105 L105 96 L125 103 L145 98 L165 100 L185 90 L216 67" />
      </svg>
      <div className={styles.chartDates}><span>Jan 1</span><span>Jan 31</span></div>
      <div className={styles.legend}><span>Impressions</span><span>Conversions</span><span>Clicks</span></div>
    </div>
  </PreviewShell>;
}

const steps = [
  { title: 'Describe your campaign', Preview: BriefPreview },
  { title: 'Review and pay', Preview: ReviewPreview },
  { title: 'Launch and learn', Preview: LearnPreview },
];

export default function CreatorGuide() {
  return <section className={styles.guide} aria-label="Creator campaign walkthrough">
    <h1>Create a campaign</h1>
    <div className={styles.steps} tabIndex={0} aria-label="Campaign steps">
      {steps.map(({ title, Preview }, index) => <div className={styles.step} key={title}>
        <Preview />
        <h2>{index + 1}. {title}</h2>
      </div>)}
    </div>
  </section>;
}
