import { useCallback, useEffect, useState } from "react";

interface WorklogDaySummary {
  date: string;
  sessionCount: number;
  promptCount: number;
}
interface WorklogPrompt {
  ts: string;
  prompt: string;
}
interface WorklogSession {
  sessionId: string;
  firstTs: string;
  lastTs: string;
  transcript?: string;
  prompts: WorklogPrompt[];
}
interface WorklogCwdGroup {
  cwd: string;
  alias: string | null;
  firstTs: string;
  lastTs: string;
  sessions: WorklogSession[];
}
interface WorklogDay {
  date: string;
  groups: WorklogCwdGroup[];
}

function timeOf(ts: string): string {
  const m = /T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : ts;
}

function App() {
  const [days, setDays] = useState<WorklogDaySummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [day, setDay] = useState<WorklogDay | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadDay = useCallback(async (date: string) => {
    setDay((await window.api.worklogDay(date)) as WorklogDay);
  }, []);

  const refresh = useCallback(async () => {
    const list = (await window.api.worklogDays()) as WorklogDaySummary[];
    setDays(list);
    setSelected((prev) =>
      list.some((d) => d.date === prev) ? prev : (list[0]?.date ?? null),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) void loadDay(selected);
    else setDay(null);
  }, [selected, loadDay]);

  const togglePrompt = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resume = (group: WorklogCwdGroup, session: WorklogSession) => {
    window.api.worklogResume({ sessionId: session.sessionId, cwd: group.cwd });
  };

  return (
    <div className="wl-app">
      {/* 左: 日期列表 */}
      <aside className="wl-side">
        <header className="wl-head">
          <span className="wl-title">工作记录</span>
          <span className="wl-actions">
            <button
              type="button"
              className="wl-btn"
              onClick={() => void refresh()}
            >
              刷新
            </button>
            <button
              type="button"
              className="wl-btn"
              onClick={() => window.api.worklogCloseView()}
            >
              关闭
            </button>
          </span>
        </header>
        {days.length === 0 && <div className="wl-empty">暂无记录</div>}
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            className={`wl-day${d.date === selected ? " active" : ""}`}
            onClick={() => setSelected(d.date)}
          >
            <div>{d.date}</div>
            <div className="wl-sub">
              {d.sessionCount} 会话 · {d.promptCount} 条
            </div>
          </button>
        ))}
      </aside>

      {/* 右: 当天按 cwd 分栏 */}
      <main className="wl-main">
        {day && day.groups.length === 0 && (
          <div className="wl-empty">这一天暂无记录</div>
        )}
        {day?.groups.map((group) => (
          <section key={group.cwd} className="wl-group">
            <header className="wl-group-head">
              <span className="wl-group-name">
                {group.alias ?? group.cwd.split("/").pop()}
              </span>
              <span className="wl-sub">{group.cwd}</span>
            </header>
            {group.sessions.map((session) => (
              <div key={session.sessionId} className="wl-session">
                <div className="wl-session-head">
                  <span className="wl-sub">
                    {timeOf(session.firstTs)} - {timeOf(session.lastTs)} ·{" "}
                    {session.prompts.length} 条
                  </span>
                  <button
                    type="button"
                    className="wl-btn"
                    onClick={() => resume(group, session)}
                  >
                    恢复
                  </button>
                </div>
                <ul className="wl-prompts">
                  {session.prompts.map((p, i) => {
                    const key = `${session.sessionId}:${i}`;
                    const isOpen = expanded.has(key);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={`wl-prompt${isOpen ? " open" : ""}`}
                          onClick={() => togglePrompt(key)}
                        >
                          <span className="wl-sub wl-time">{timeOf(p.ts)}</span>
                          <span className="wl-prompt-text">{p.prompt}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}

export default App;
