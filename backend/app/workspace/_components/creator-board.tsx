"use client";
import { useEffect, useRef, useState } from "react";
import { TaskBoard } from "@bryntum/taskboard-community";
import "@fortawesome/fontawesome-free/css/fontawesome.css";
import "@fortawesome/fontawesome-free/css/solid.css";
import "@bryntum/taskboard-community/taskboard.css";
import "@bryntum/taskboard-community/svalbard.css";
import { creators, stages } from "../../../lib/creator/catalog";
import type { Campaign } from "../../../lib/creator/policy";
export default function CreatorBoard({
  state,
  onSelect,
}: {
  state: Campaign;
  onSelect: (id: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    select = useRef(onSelect);
  select.current = onSelect;
  const [stage, setStage] = useState("all");
  const tasks = [
    ...state.candidates.map((c) => c.id),
    ...state.deals.map((d) => d.creatorId),
  ]
    .filter((id, i, a) => a.indexOf(id) === i)
    .map((id) => ({
      id,
      name: creators.find((c) => c.id === id)!.name,
      status:
        state.deals.find((d) => d.creatorId === id)?.stage || "shortlisted",
    }));
  const signature = JSON.stringify(tasks);
  useEffect(() => {
    if (!host.current) return;
    const board = new TaskBoard({
      appendTo: host.current,
      height: 360,
      readOnly: true,
      columnField: "status",
      columns: stages.map((c) => ({ ...c, minWidth: 190, collapsible: false })),
      project: { tasks: JSON.parse(signature) },
      features: {
        columnToolbars: false,
        columnHeaderMenu: false,
        taskMenu: false,
        taskEdit: false,
        taskDrag: false,
      },
      onTaskClick: ({ taskRecord }) => select.current(String(taskRecord.id)),
    });
    return () => board.destroy();
  }, [signature]);
  return (
    <>
      <div
        className="hidden overflow-hidden rounded-2xl border border-border md:block"
        aria-label="Campaign board"
        ref={host}
      />
      <div className="flex flex-col gap-3 md:hidden">
        <label className="text-sm">
          Stage
          <select
            className="ml-3 rounded-lg border p-2"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
          >
            <option value="all">All</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.text}
              </option>
            ))}
          </select>
        </label>
        {tasks
          .filter((t) => stage === "all" || t.status === stage)
          .map((t) => (
            <button
              key={t.id}
              className="flex justify-between rounded-xl bg-muted p-4 text-left text-sm"
              onClick={() => onSelect(t.id)}
            >
              {t.name}
              <span>{stages.find((s) => s.id === t.status)?.text}</span>
            </button>
          ))}
      </div>
    </>
  );
}
