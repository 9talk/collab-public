import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReplayCommit } from "@collab/shared/types";
import "./ReplayTimeline.css";

export interface ReplayTimelineProps {
  commits: ReplayCommit[];
  currentIndex: number;
  isPlaying: boolean;
  isLoading: boolean;
  totalCommits: number | null;
  timeRange: [number, number] | null;
  onPlay: () => void;
  onPause: () => void;
  onSeekTo: (index: number) => void;
  onSeekToLive: () => void;
}

interface DateLabel {
  position: number;
  text: string;
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 20;
const MS_PER_DAY = 86_400_000;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function computeDateLabels(
  timeRange: [number, number],
  trackWidth: number,
): DateLabel[] {
  const [start, end] = timeRange;
  const span = end - start;
  if (span <= 0 || trackWidth <= 0) return [];

  const labels: DateLabel[] = [];
  const minLabelSpacing = 60;
  const maxLabels = Math.floor(trackWidth / minLabelSpacing);

  if (span > MS_PER_YEAR * 2) {
    addYearLabels(start, end, span, maxLabels, labels);
  } else if (span > MS_PER_MONTH * 3) {
    addMonthLabels(start, end, span, maxLabels, labels);
  } else {
    addDayLabels(start, end, span, maxLabels, labels);
  }

  return labels;
}

function addYearLabels(
  start: number,
  end: number,
  span: number,
  maxLabels: number,
  labels: DateLabel[],
): void {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();
  const step = Math.max(
    1,
    Math.ceil((endYear - startYear + 1) / maxLabels),
  );
  for (let y = startYear; y <= endYear; y += step) {
    const ts = new Date(y, 0, 1).getTime();
    if (ts >= start && ts <= end) {
      labels.push({
        position: (ts - start) / span,
        text: String(y),
      });
    }
  }
}

function addMonthLabels(
  start: number,
  end: number,
  span: number,
  maxLabels: number,
  labels: DateLabel[],
): void {
  const startDate = new Date(start);
  const year = startDate.getFullYear();
  const month = startDate.getMonth();
  const totalMonths = Math.ceil(span / MS_PER_MONTH);
  const step = Math.max(1, Math.ceil(totalMonths / maxLabels));
  for (let i = 0; i < totalMonths + step; i += step) {
    const m = month + i;
    const y = year + Math.floor(m / 12);
    const mNorm = m % 12;
    const ts = new Date(y, mNorm, 1).getTime();
    if (ts < start) continue;
    if (ts > end) break;
    const text = mNorm === 0
      ? `${MONTH_NAMES[mNorm]} ${y}`
      : MONTH_NAMES[mNorm]!;
    labels.push({ position: (ts - start) / span, text });
  }
}

function addDayLabels(
  start: number,
  end: number,
  span: number,
  maxLabels: number,
  labels: DateLabel[],
): void {
  const totalDays = Math.ceil(span / MS_PER_DAY);
  const step = Math.max(1, Math.ceil(totalDays / maxLabels));
  const startDate = new Date(start);
  startDate.setHours(0, 0, 0, 0);
  const baseTs = startDate.getTime();
  for (let d = 0; d <= totalDays + step; d += step) {
    const ts = baseTs + d * MS_PER_DAY;
    if (ts < start) continue;
    if (ts > end) break;
    const date = new Date(ts);
    const text = `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`;
    labels.push({ position: (ts - start) / span, text });
  }
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

function findNearestCommitIndex(
  commits: ReplayCommit[],
  targetTimestamp: number,
): number {
  if (commits.length === 0) return -1;
  let bestIdx = 0;
  let bestDist = Math.abs(
    commits[0]!.timestamp - targetTimestamp,
  );
  for (let i = 1; i < commits.length; i++) {
    const dist = Math.abs(
      commits[i]!.timestamp - targetTimestamp,
    );
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function useTimelineDrag(
  trackRef: React.RefObject<HTMLDivElement | null>,
  timeRange: [number, number] | null,
  commits: ReplayCommit[],
  isPlaying: boolean,
  onPause: () => void,
  onSeekTo: (index: number) => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || !timeRange) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width),
      );
      const [start, end] = timeRange;
      const ts = start + fraction * (end - start);
      const idx = findNearestCommitIndex(commits, ts);
      if (idx >= 0) onSeekTo(idx);
    },
    [trackRef, timeRange, commits, onSeekTo],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      isDraggingRef.current = true;
      if (isPlaying) onPause();
      seekFromClientX(e.clientX);
    },
    [isPlaying, onPause, seekFromClientX],
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      seekFromClientX(e.clientX);
    };
    const handleUp = () => {
      setIsDragging(false);
      isDraggingRef.current = false;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging, seekFromClientX]);

  return { isDraggingRef, handleMouseDown };
}

function useTimelineHover(
  trackRef: React.RefObject<HTMLDivElement | null>,
  isDraggingRef: React.RefObject<boolean>,
  timeRange: [number, number] | null,
  trackWidth: number,
  commits: ReplayCommit[],
) {
  const [hoverX, setHoverX] = useState<number | null>(null);

  const handleTrackHover = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingRef.current) return;
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setHoverX(e.clientX - rect.left);
    },
    [isDraggingRef, trackRef],
  );

  const handleTrackLeave = useCallback(() => {
    if (!isDraggingRef.current) setHoverX(null);
  }, [isDraggingRef]);

  const hoveredCommit = useMemo(() => {
    if (hoverX === null || !timeRange || trackWidth <= 0) {
      return null;
    }
    const fraction = hoverX / trackWidth;
    const [start, end] = timeRange;
    const ts = start + fraction * (end - start);
    const idx = findNearestCommitIndex(commits, ts);
    if (idx < 0) return null;
    return { index: idx, commit: commits[idx]! };
  }, [hoverX, timeRange, trackWidth, commits]);

  return { hoverX, hoveredCommit, handleTrackHover, handleTrackLeave };
}

export function ReplayTimeline({
  commits,
  currentIndex,
  isPlaying,
  isLoading,
  totalCommits,
  timeRange,
  onPlay,
  onPause,
  onSeekTo,
  onSeekToLive,
}: ReplayTimelineProps) {
  const [isOpen, setIsOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setTrackWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { isDraggingRef, handleMouseDown } = useTimelineDrag(
    trackRef, timeRange, commits,
    isPlaying, onPause, onSeekTo,
  );

  const { hoverX, hoveredCommit, handleTrackHover, handleTrackLeave } =
    useTimelineHover(
      trackRef, isDraggingRef,
      timeRange, trackWidth, commits,
    );

  const commitPositions = useMemo(() => {
    if (!timeRange || commits.length === 0) return [];
    const [start, end] = timeRange;
    const span = end - start;
    if (span <= 0) {
      return commits.map(() => 0.5);
    }
    return commits.map(
      (c) => (c.timestamp - start) / span,
    );
  }, [commits, timeRange]);

  const dateLabels = useMemo(
    () =>
      timeRange
        ? computeDateLabels(timeRange, trackWidth)
        : [],
    [timeRange, trackWidth],
  );

  const playheadPosition = useMemo(() => {
    if (currentIndex === -1) return 1;
    if (
      currentIndex >= 0 &&
      currentIndex < commitPositions.length
    ) {
      return commitPositions[currentIndex]!;
    }
    return 1;
  }, [currentIndex, commitPositions]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      onPause();
    } else {
      if (currentIndex === -1 && commits.length > 0) {
        onSeekTo(0);
      }
      onPlay();
    }
  }, [
    isPlaying,
    currentIndex,
    commits.length,
    onPlay,
    onPause,
    onSeekTo,
  ]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    onSeekToLive();
    setIsOpen(false);
  }, [onSeekToLive]);

  const playDisabled = isLoading;

  const showProgress =
    isLoading &&
    totalCommits !== null &&
    totalCommits > 0;

  const progressFraction = showProgress
    ? commits.length / totalCommits!
    : 0;

  return (
    <div
      className={
        "replay-timeline" +
        (isOpen
          ? " replay-timeline--expanded"
          : " replay-timeline--collapsed") +
        (isLoading ? " replay-timeline--loading" : "")
      }
      onClick={isOpen || isLoading ? undefined : handleOpen}
    >
      <button
        className="replay-timeline-trigger"
        aria-label="Open git history"
        tabIndex={isOpen || isLoading ? -1 : 0}
        disabled={isLoading}
      >
        <ClockIcon />
      </button>

      {isLoading && !isOpen && (
        <svg className="replay-timeline-loading-ring" viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            r="20"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={
              RING_CIRCUMFERENCE * (1 - progressFraction)
            }
          />
        </svg>
      )}

      <div className="replay-timeline-contents">
        <button
          className="replay-timeline-pill-btn"
          onClick={handlePlayPause}
          disabled={playDisabled}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div
          className="replay-timeline-track-area"
          ref={trackRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleTrackHover}
          onMouseLeave={handleTrackLeave}
        >
          <div className="replay-timeline-track">
            <div className="replay-timeline-rail" />
            <div
              className="replay-timeline-rail-fill"
              style={{ width: `${playheadPosition * 100}%` }}
            />

            {commitPositions.map((pos, i) => (
              <div
                key={i}
                className={
                  "replay-timeline-tick" +
                  (currentIndex !== -1 && i > currentIndex
                    ? " replay-timeline-tick--unplayed"
                    : "")
                }
                style={{ left: `${pos * 100}%` }}
              />
            ))}

            <div
              className="replay-timeline-playhead"
              style={{
                left: `${playheadPosition * 100}%`,
              }}
            />
          </div>

          <div className="replay-timeline-labels">
            {dateLabels.map((label, i) => (
              <span
                key={i}
                className="replay-timeline-label"
                style={{ left: `${label.position * 100}%` }}
              >
                {label.text}
              </span>
            ))}
            <span
              className="replay-timeline-label replay-timeline-label-now"
              style={{ left: "100%" }}
            >
              Now
            </span>
          </div>

          {hoveredCommit && hoverX !== null ? (
            <Tooltip
              commit={hoveredCommit.commit}
              trackX={hoverX}
              trackWidth={trackWidth}
            />
          ) : isPlaying &&
            currentIndex >= 0 &&
            currentIndex < commits.length ? (
            <Tooltip
              commit={commits[currentIndex]!}
              trackX={playheadPosition * trackWidth}
              trackWidth={trackWidth}
            />
          ) : null}

          {showProgress && (
            <div
              className="replay-timeline-progress"
              style={{
                width: `${progressFraction * 100}%`,
              }}
            />
          )}
        </div>

        <button
          className="replay-timeline-pill-btn replay-timeline-close-btn"
          onClick={handleClose}
          aria-label="Close history"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
      <polygon points="3,1 12,7 3,13" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="1" width="3.5" height="12" />
      <rect x="8.5" y="1" width="3.5" height="12" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12,6 12,12 8,14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
      <line x1="2" y1="2" x2="12" y2="12" />
      <line x1="12" y1="2" x2="2" y2="12" />
    </svg>
  );
}

function Tooltip({
  commit,
  trackX,
  trackWidth,
}: {
  commit: ReplayCommit;
  trackX: number;
  trackWidth: number;
}) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const half = w / 2;
    const leftEdge = trackX - half;
    const rightEdge = trackX + half;
    if (leftEdge < 0) {
      setOffset(-leftEdge);
    } else if (rightEdge > trackWidth) {
      setOffset(trackWidth - rightEdge);
    } else {
      setOffset(0);
    }
  }, [trackX, trackWidth]);

  return (
    <div
      ref={tooltipRef}
      className="replay-timeline-tooltip"
      style={{
        left: `${trackX + offset}px`,
        bottom: "100%",
        transform: "translateX(-50%)",
        marginBottom: "4px",
      }}
    >
      <div className="replay-timeline-tooltip-hash">
        {commit.hash.slice(0, 7)}
      </div>
      <div className="replay-timeline-tooltip-subject">
        {truncate(commit.subject, 60)}
      </div>
      <div className="replay-timeline-tooltip-meta">
        {commit.author} &middot;{" "}
        {formatDate(commit.timestamp)}
      </div>
    </div>
  );
}
