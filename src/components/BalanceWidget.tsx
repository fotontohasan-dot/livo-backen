'use client';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { motion } from 'framer-motion';

export const BalanceWidget = () => {
  const [balance, setBalance] = useState(1568523);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshBalance = () => {
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  return (
    <div className="flex items-center gap-2 bg-surface-elevated border border-border rounded-full px-4 py-1.5">
      <div className="flex flex-col">
        <span className="text-[10px] text-text-muted leading-none">Balance</span>
        <span className="text-accent-text font-bold text-lg leading-none mt-1">
          ৳{balance.toLocaleString('en-US')}
        </span>
      </div>
      <motion.button
        animate={{ rotate: isRefreshing ? 360 : 0 }}
        transition={{ duration: 1, repeat: isRefreshing ? Infinity : 0, ease: "linear" }}
        onClick={refreshBalance}
        className="text-accent-text hover:text-accent-hover transition-colors"
      >
        <RefreshCw size={18} />
      </motion.button>
    </div>
  );
};
