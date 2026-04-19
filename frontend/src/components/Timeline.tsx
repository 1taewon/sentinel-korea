interface TimelineProps {
  dates: string[];
  currentDate: string;
  onChange: (date: string) => void;
}

function shortDate(date: string): string {
  // "2026-01-04" → "01-04"
  return date.slice(5);
}

export default function Timeline({ dates, currentDate, onChange }: TimelineProps) {
  return (
    <div className="timeline-container">
      <div className="timeline-current-label">
        <span className="timeline-current-icon">▸</span>
        {currentDate}
      </div>
      <div className="timeline-track">
        {dates.map((date, index) => {
          const isActive = date === currentDate;
          return (
            <div key={date} className="timeline-point">
              <button
                className={`timeline-dot ${isActive ? 'active' : ''}`}
                onClick={() => onChange(date)}
                title={date}
              />
              <div className="timeline-label">{shortDate(date)}</div>
              {index < dates.length - 1 && <div className="timeline-line" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
