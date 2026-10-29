'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

// ব্যাকএন্ড GET /games/api/list-এর প্রতিটি গেমের আকার
export interface LobbyGame {
  id: number;
  slug: string;
  name: string;
  category: string | null;
  sub_category: string | null;
  provider: string | null;
  provider_game_id: string | null;
  thumbnail_url: string | null;
  rtp: number | string | null;
  has_demo: boolean | null;
}

interface ListResponse {
  success: boolean;
  games: LobbyGame[];
  page: number;
  hasMore: boolean;
}

interface GameListProps {
  category?: string; // যেমন "slots"; খালি হলে সব
  provider?: string;
  query?: string; // নাম দিয়ে সার্চ
  /** ডিফল্ট '' (একই ডোমেইন)। আলাদা ডোমেইন হলে NEXT_PUBLIC_API_BASE দিন */
  apiBase?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

function GameTile({ game }: { game: LobbyGame }) {
  const [imgFailed, setImgFailed] = useState(false);
  const canLaunch = !!(game.provider && game.provider_game_id);
  const href = canLaunch
    ? `/games/launch/${encodeURIComponent(game.provider as string)}/${encodeURIComponent(
        game.provider_game_id as string
      )}`
    : undefined;
  const rtp = game.rtp !== null && game.rtp !== '' ? Number(game.rtp) : null;

  const body = (
    <div className="card-premium relative group overflow-hidden transition-transform hover:-translate-y-1">
      {game.has_demo ? (
        <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded text-[10px] font-bold bg-accent-soft text-accent-text">
          DEMO
        </span>
      ) : null}

      <div className="aspect-square bg-background-secondary flex items-center justify-center">
        {game.thumbnail_url && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={game.thumbnail_url}
            alt={game.name}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="text-5xl" aria-hidden="true">🎮</span>
        )}
      </div>

      <div className="p-3 bg-surface/85 border-t border-border">
        <div className="text-sm font-bold truncate text-text-primary" title={game.name}>
          {game.name}
        </div>
        <div className="flex items-center justify-between text-[10px] text-accent-text font-medium tracking-wider">
          <span className="truncate">{game.provider ?? ''}</span>
          {rtp !== null && Number.isFinite(rtp) ? <span>RTP {rtp.toFixed(1)}%</span> : null}
        </div>
      </div>
    </div>
  );

  return href ? (
    <a href={href} className="block" aria-label={`${game.name} খেলুন`}>
      {body}
    </a>
  ) : (
    <div className="opacity-60" aria-disabled="true">{body}</div>
  );
}

export function GameList({ category, provider, query, apiBase = API_BASE }: GameListProps) {
  const [games, setGames] = useState<LobbyGame[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0); // পুরনো রেসপন্স নতুন ফিল্টারের ফলাফল ওভাররাইট করা ঠেকায়

  const load = useCallback(
    async (pageToLoad: number, append: boolean) => {
      const myId = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ page: String(pageToLoad) });
        if (category && category !== 'all') qs.set('category', category);
        if (provider && provider !== 'all') qs.set('provider', provider);
        if (query) qs.set('q', query);

        const res = await fetch(`${apiBase}/games/api/list?${qs.toString()}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ListResponse = await res.json();
        if (myId !== requestId.current) return;

        setGames((prev) => (append ? [...prev, ...data.games] : data.games));
        setPage(data.page);
        setHasMore(data.hasMore);
      } catch (e) {
        if (myId !== requestId.current) return;
        setError('গেমের তালিকা লোড করা যায়নি। আবার চেষ্টা করুন।');
      } finally {
        if (myId === requestId.current) setLoading(false);
      }
    },
    [apiBase, category, provider, query]
  );

  // ফিল্টার বদলালে প্রথম পেজ থেকে শুরু
  useEffect(() => {
    load(1, false);
  }, [load]);

  if (error && games.length === 0) {
    return (
      <div className="text-center py-10" role="alert">
        <p className="text-text-primary mb-3">{error}</p>
        <button
          onClick={() => load(1, false)}
          className="bg-accent text-on-accent px-4 py-2 rounded-full font-bold text-sm"
        >
          আবার চেষ্টা করুন
        </button>
      </div>
    );
  }

  if (!loading && games.length === 0) {
    return <p className="text-center py-10 text-text-primary">কোনো গেম পাওয়া যায়নি।</p>;
  }

  return (
    <section aria-busy={loading}>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {games.map((g) => (
          <GameTile key={g.id} game={g} />
        ))}
        {loading &&
          games.length === 0 &&
          Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="card-premium aspect-[4/5] animate-pulse bg-background-secondary" />
          ))}
      </div>

      {error ? <p className="text-center text-sm mt-4" role="alert">{error}</p> : null}

      {hasMore ? (
        <div className="text-center mt-6">
          <button
            disabled={loading}
            onClick={() => load(page + 1, true)}
            className="bg-accent text-on-accent px-6 py-2 rounded-full font-bold text-sm disabled:opacity-50"
          >
            {loading ? 'লোড হচ্ছে…' : 'আরও দেখুন'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default GameList;
