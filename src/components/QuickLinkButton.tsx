import { ReactNode } from 'react';
import Link from 'next/link';

interface QuickLinkProps {
  href: string;
  icon: ReactNode;
  label: string;
  badge?: string;
  color: string;
}

export const QuickLinkButton = ({ href, icon, label, badge, color }: QuickLinkProps) => {
  return (
    <Link href={href} className="flex flex-col items-center gap-2 group">
      <div className={`relative w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-lg transition-transform group-hover:-translate-y-1 group-active:scale-95`} style={{ background: color }}>
        {icon}
        {badge && (
          <div className="absolute -top-1 -right-1 bg-danger text-white text-[8px] font-black px-1.5 py-0.5 rounded-full border-2 border-background">
            {badge}
          </div>
        )}
      </div>
      <span className="text-[10px] font-bold text-text-primary group-hover:text-accent-text transition-colors">{label}</span>
    </Link>
  );
};
