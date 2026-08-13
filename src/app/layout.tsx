import type { Metadata } from "next";
import "./globals.css";

// next/font/google বিল্ড-টাইমে fonts.googleapis.com থেকে ফন্ট ডাউনলোড করার চেষ্টা করে —
// নেটওয়ার্ক-সীমিত CI, কন্টেইনার বা এয়ার-গ্যাপড এনভায়রনমেন্টে সেটা `next build`-কেই ফেল
// করিয়ে দিত। তাই ফন্ট এখন globals.css-এর সিস্টেম ফন্ট-স্ট্যাক থেকে আসে — কোনো বাহ্যিক
// নেটওয়ার্ক নির্ভরতা নেই, বিল্ড সম্পূর্ণ অফলাইনে চলে।

export const metadata: Metadata = {
  title: "Livo – Premium Gaming",
  description: "Experience the next level of gaming with Livo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
