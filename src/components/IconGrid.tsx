import { ReactNode } from 'react';

interface IconGridProps {
  items: {
    icon: ReactNode;
    label: string;
    onClick?: () => void;
    href?: string;
    badge?: string | number;
  }[];
  columns?: number;
}

export const IconGrid = ({ items, columns = 4 }: IconGridProps) => {
  const gridCols = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
  }[columns] || 'grid-cols-4';

  return (
    <div className={`grid ${gridCols} gap-4`}>
      {items.map((item, index) => (
        <button
          key={index}
          onClick={item.onClick}
          className="flex flex-col items-center gap-2 p-3 rounded-2xl hover:bg-white/5 transition-colors group relative"
        >
          <div className="text-primary group-hover:scale-110 transition-transform">
            {item.icon}
          </div>
          <span className="text-[11px] font-medium text-text-muted group-hover:text-text-main transition-colors text-center leading-tight">
            {item.label}
          </span>
          {item.badge && (
            <div className="absolute top-2 right-4 bg-accent text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full border border-background">
              {item.badge}
            </div>
          )}
        </button>
      ))}
    </div>
  );
};
