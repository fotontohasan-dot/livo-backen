'use client';
import { useState } from 'react';
import { GameList } from '@/components/GameList';

export default function GamesPage() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  return (
    <main className="min-h-screen px-4 py-6 bg-background text-text-primary">
      <h1 className="text-xl font-bold mb-4">গেম লবি</h1>
      <div className="flex gap-2 mb-5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setSearch(q.trim())}
          placeholder="গেম খুঁজুন…"
          className="flex-1 px-3 py-2 rounded-lg bg-surface border border-border"
        />
        <button
          onClick={() => setSearch(q.trim())}
          className="bg-accent text-on-accent px-4 py-2 rounded-lg font-bold text-sm"
        >
          খুঁজুন
        </button>
      </div>
      <GameList query={search} />
    </main>
  );
}
