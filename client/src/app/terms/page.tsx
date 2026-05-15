'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TermsPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/onboarding'); }, [router]);
  return null;
}
