interface TimelineProps {
  dates: string[];
  currentDate: string;
  onChange: (date: string) => void;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO 8601 week number for a YYYY-MM-DD date. */
function epiWeekOf(dateStr: string): { year: number; week: number } {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return { year: 0, week: 0 };
  // Move to Thursday in the same ISO week (ISO weeks start on Monday)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: target.getUTCFullYear(), week };
}

/** Return (start, end) of the ISO week containing dateStr, both as Date objects in UTC. */
function isoWeekRange(dateStr: string): { start: Date; end: Date } {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;             // Mon=1 ... Sun=7
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - (day - 1));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

function fmtMD(d: Date): string {
  return `${MONTH_LABELS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export default function Timeline({ dates, currentDate, onChange }: TimelineProps) {
  const { year: curYear, week: curWeek } = epiWeekOf(currentDate);
  const { start: curStart, end: curEnd } = isoWeekRange(currentDate);

  return (
    <div className="timeline-container timeline-container--calendar">
      <div className="timeline-current-card">
        <div className="timeline-current-top">
          <span className="timeline-current-kicker">현재 주차 · CURRENT</span>
          <strong>{curYear}-W{String(curWeek).padStart(2, '0')}</strong>
        </div>
        <span className="timeline-current-range">{fmtMD(curStart)} – {fmtMD(curEnd)}</span>
      </div>

      <div className="timeline-week-list">
        {[...dates].slice().reverse().slice(0, 4).map((date) => {
          const isActive = date === currentDate;
          const { year, week } = epiWeekOf(date);
          const { start, end } = isoWeekRange(date);
          return (
            <button
              key={date}
              type="button"
              className={`timeline-week-row ${isActive ? 'is-active' : ''}`}
              onClick={() => onChange(date)}
              title={date}
            >
              <span className="timeline-week-tag">{year}-W{String(week).padStart(2, '0')}</span>
              <span className="timeline-week-range">{fmtMD(start)} – {fmtMD(end)}</span>
              <span className="timeline-week-snapshot">{date.slice(5)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
