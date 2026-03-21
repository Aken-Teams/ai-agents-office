'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from './AuthProvider';
import styles from './Navbar.module.css';

export default function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();

  if (!user) return null;

  const links = [
    { href: '/dashboard', label: 'Dashboard', icon: '\u2302' },
    { href: '/files', label: 'Files', icon: '\u{1F4C1}' },
    { href: '/usage', label: 'Usage', icon: '\u{1F4CA}' },
  ];

  return (
    <nav className={styles.navbar}>
      <div className={styles.logo}>
        <span className={styles.logoIcon}>AI</span>
        <span>Agents Office</span>
      </div>

      <div className={styles.links}>
        {links.map(link => (
          <Link
            key={link.href}
            href={link.href}
            className={`${styles.link} ${pathname === link.href ? styles.active : ''}`}
          >
            {link.label}
          </Link>
        ))}
      </div>

      <div className={styles.user}>
        <span className={styles.email}>{user.displayName || user.email}</span>
        <button className="btn-secondary" onClick={logout} style={{ padding: '6px 12px', fontSize: '13px' }}>
          Logout
        </button>
      </div>
    </nav>
  );
}
