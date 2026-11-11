-- scripts/loadtest/sql/enable_pg_stat_statements.sql — শুধু STAGING ডাটাবেসে চালান (production-এ নয়)।
-- Render Postgres-এ pg_stat_statements সাধারণত লোড করা থাকে; নিশ্চিত হতে আগে এটা দেখুন:
--   SHOW shared_preload_libraries;      -- 'pg_stat_statements' থাকা উচিত। না থাকলে Render সাপোর্ট/প্ল্যান সীমা দেখুন (নিচে নোট)।
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- টেস্ট শুরুর ঠিক আগে কাউন্টার শূন্য করুন, যাতে রিপোর্ট শুধু লোড-টেস্টের কোয়েরি দেখায়:
SELECT pg_stat_statements_reset();
-- যাচাই:
SELECT count(*) AS tracked_statements FROM pg_stat_statements;
