'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ব্যাকএন্ড GET /matches/api/live-এর প্রতিটি ম্যাচের আকার (formatMatch)
export interface LiveMatch {
  id: number;
  sport: string;
  league: string | null;
  name: string | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: string | number | null;
  awayScore: string | number | null;
  overs: string | null;
  status: string; // 'live' | 'upcoming' | অন্য (finished ইত্যাদি)
  date: string | null;
}

interface LiveResponse {
  success: boolean;
  cricket?: LiveMatch[];
  football?: LiveMatch[];
  [sport: string]: unknown;
}

interface SportsLiveProps {
  /** ডিফল্ট '' (একই ডোমেইন); আলাদা ডোমেইনে NEXT_PUBLIC_API_BASE */
  apiBase?: string;
  /** রিফ্রেশের ব্যবধান (ms) — সার্ভার ক্যাশ ১০ সেকেন্ড, তাই এর কম রেখে লাভ নেই */
  refreshMs?: number;
  view?: 'grid' | 'list';
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

const SPORT_META: Record<string, { label: string; icon: string }> = {
  cricket: { label: 'ক্রিকেট', icon: '🏏' },
  football: { label: 'ফুটবল', icon: '⚽' },
  tennis: { label: 'টেনিস', icon: '🎾' },
  basketball: { label: 'বাস্কেটবল', icon: '🏀' },
  kabaddi: { label: 'কাবাডি', icon: '🤼' },
  hockey: { label: 'হকি', icon: '🏑' },
};

function sportMeta(sport: string) {
  const key = sport.toLowerCase();
  return SPORT_META[key] ?? { label: sport, icon: '🏅' };
}

function formatStart(date: string | null): string {
  if (!date) return 'সময় নির্ধারিত নয়';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return 'সময় নির্ধারিত নয়';
  return d.toLocaleString('bn-BD', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MatchCard({ m, list }: { m: LiveMatch; list: boolean }) {
  const isLive = m.status === 'live';
  const hasScore = m.homeScore !== null || m.awayScore !== null;
  const meta = sportMeta(m.sport);

  return (
    <a
      href={`/matches/${m.id}`}
      className={`card-premium block transition-transform hover:-translate-y-1 ${list ? 'p-3' : 'p-4'}`}
    >
      <div className="flex items-center justify-between text-[11px] mb-2">
        <span className="text-accent-text font-medium truncate">
          {meta.icon} {m.league || meta.label}
        </span>
        {isLive ? (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600 text-white font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" aria-hidden="true" />
            LIVE
          </span>
        ) : (
          <span className="text-text-primary opacity-70">{formatStart(m.date)}</span>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-text-primary truncate">{m.homeTeam}</span>
          <span className="font-bold text-sm text-accent-text tabular-nums">
            {hasScore ? m.homeScore ?? '-' : ''}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-bold text-sm text-text-primary truncate">{m.awayTeam}</span>
          <span className="font-bold text-sm text-accent-text tabular-nums">
            {hasScore ? m.awayScore ?? '-' : ''}
          </span>
        </div>
      </div>

      {m.overs ? (
        <div className="mt-2 text-[11px] text-text-primary opacity-70">ওভার: {m.overs}</div>
      ) : null}
    </a>
  );
}

export function SportsLive({ apiBase = API_BASE, refreshMs = 15000, view = 'grid' }: SportsLiveProps) {
  const [matches, setMatches] = useState<LiveMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sport, setSport] = useState('all');
  const [status, setStatus] = useState<'all' | 'live' | 'upcoming'>('all');
  const [layout, setLayout] = useState(view);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch(`${apiBase}/matches/api/live`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: LiveResponse = await res.json();

      // কোনো নির্দিষ্ট স্পোর্টের নাম ধরে নেওয়া হয়নি: রেসপন্সের সব অ্যারে একসাথে করে
      // প্রতিটা ম্যাচের নিজস্ব `sport` ফিল্ড দিয়ে ক্যাটাগরি তৈরি হয়।
      const all: LiveMatch[] = [];
      for (const value of Object.values(data)) {
        if (Array.isArray(value)) all.push(...(value as LiveMatch[]));
      }
      setMatches(all);
      setUpdatedAt(new Date());
      setError(null);
    } catch {
      setError('লাইভ ডেটা লোড করা যায়নি।');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [apiBase]);

  // প্রথম লোড + নির্দিষ্ট ব্যবধানে রিফ্রেশ (ট্যাব লুকানো থাকলে বিরতি)
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, refreshMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, refreshMs]);

  // ডেটায় যে স্পোর্টগুলো আছে সেগুলো থেকেই ট্যাব তৈরি (ডায়নামিক)
  const sports = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of matches) counts.set(m.sport, (counts.get(m.sport) ?? 0) + 1);
    return Array.from(counts.entries());
  }, [matches]);

  const visible = useMemo(
    () =>
      matches.filter(
        (m) => (sport === 'all' || m.sport === sport) && (status === 'all' || m.status === status)
      ),
    [matches, sport, status]
  );

  const liveCount = useMemo(() => matches.filter((m) => m.status === 'live').length, [matches]);

  const tabClass = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-sm font-bold whitespace-nowrap ${
      active ? 'bg-accent text-on-accent' : 'bg-surface border border-border text-text-primary'
    }`;

  return (
    <section aria-busy={loading}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-text-primary">
          লাইভ ও আসন্ন ম্যাচ{liveCount > 0 ? ` · ${liveCount}টি লাইভ` : ''}
        </h2>
        <div className="flex gap-1" role="group" aria-label="প্রদর্শনের ধরন">
          <button className={tabClass(layout === 'grid')} onClick={() => setLayout('grid')}>গ্রিড</button>
          <button className={tabClass(layout === 'list')} onClick={() => setLayout('list')}>লিস্ট</button>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="খেলার ধরন">
        <button role="tab" aria-selected={sport === 'all'} className={tabClass(sport === 'all')} onClick={() => setSport('all')}>
          সব ({matches.length})
        </button>
        {sports.map(([s, n]) => (
          <button
            key={s}
            role="tab"
            aria-selected={sport === s}
            className={tabClass(sport === s)}
            onClick={() => setSport(s)}
          >
            {sportMeta(s).icon} {sportMeta(s).label} ({n})
          </button>
        ))}
      </div>

      <div className="flex gap-2 my-3">
        {(['all', 'live', 'upcoming'] as const).map((s) => (
          <button key={s} className={tabClass(status === s)} onClick={() => setStatus(s)}>
            {s === 'all' ? 'সব' : s === 'live' ? 'লাইভ' : 'আসন্ন'}
          </button>
        ))}
      </div>

      {error && matches.length === 0 ? (
        <div className="text-center py-10" role="alert">
          <p className="text-text-primary mb-3">{error}</p>
          <button onClick={load} className="bg-accent text-on-accent px-4 py-2 rounded-full font-bold text-sm">
            আবার চেষ্টা করুন
          </button>
        </div>
      ) : loading && matches.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card-premium h-24 animate-pulse bg-background-secondary" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <p className="text-center py-10 text-text-primary">এই মুহূর্তে কোনো ম্যাচ নেই।</p>
      ) : (
        <div
          className={
            layout === 'grid'
              ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'
              : 'flex flex-col gap-2'
          }
        >
          {visible.map((m) => (
            <MatchCard key={m.id} m={m} list={layout === 'list'} />
          ))}
        </div>
      )}

      <div className="mt-4 text-[11px] text-text-primary opacity-60 text-center">
        {error && matches.length > 0 ? 'আপডেট ব্যর্থ — আগের ডেটা দেখানো হচ্ছে · ' : ''}
        {updatedAt ? `সর্বশেষ আপডেট: ${updatedAt.toLocaleTimeString('bn-BD')}` : ''}
      </div>
    </section>
  );
}

export default SportsLive;
