"use client";

export function Mascot({
  color,
  small = false,
}: {
  color: string;
  small?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 128 128"
      className={small ? "size-9 shrink-0" : "size-12 shrink-0"}
    >
      <path
        fill={color}
        d="M64 17C88 17 107 32 109 55C112 80 96 105 70 109C45 113 22 99 19 76C15 51 36 18 64 17Z"
      />
      <rect x="47" y="53" width="10" height="22" rx="5" fill="#252420" />
      <rect x="72" y="50" width="10" height="22" rx="5" fill="#252420" />
    </svg>
  );
}

export function AgentTeamHeader({
  participants,
  title,
  description,
  action,
}: {
  participants: { name: string; color: string }[];
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <>
      <div className="mb-4 flex -space-x-2">
        {participants.map((agent, index) => (
          <Mascot key={`${agent.name}-${index}`} color={agent.color} />
        ))}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-medium">{title}</p>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
    </>
  );
}
