// 演示商品图：本地生成的 SVG（进程内商品适配器只引用路径）
import { mkdirSync, writeFileSync } from 'node:fs';

const SPECS = {
  p1: { bg: '#F7E9E4', accent: '#FF6B6B', shape: 'droplet', label: '气垫 BB' },
  p2: { bg: '#E7E6E4', accent: '#2B2B33', shape: 'bottle', label: '保温杯' },
  p3: { bg: '#FCE7E3', accent: '#FF6B6B', shape: 'lip', label: '唇釉' },
  p4: { bg: '#EEF3EE', accent: '#5E8B6F', shape: 'cup', label: '榨汁杯' },
  p5: { bg: '#ECEAE6', accent: '#2B2B33', shape: 'umbrella', label: '晴雨伞' },
  p6: { bg: '#F6EDDF', accent: '#D89A5B', shape: 'candle', label: '蜡烛' },
};

function figure(shape, accent) {
  switch (shape) {
    case 'droplet':
      return `<ellipse cx="150" cy="150" rx="70" ry="58" fill="${accent}" opacity="0.9"/>
        <ellipse cx="128" cy="132" rx="22" ry="14" fill="#fff" opacity="0.45"/>`;
    case 'bottle':
      return `<rect x="118" y="86" width="64" height="14" rx="4" fill="${accent}"/>
        <rect x="108" y="100" width="84" height="104" rx="16" fill="${accent}"/>
        <rect x="108" y="132" width="84" height="10" fill="#FBF6EC" opacity="0.85"/>`;
    case 'lip':
      return `<g transform="rotate(-18 150 150)"><rect x="132" y="80" width="36" height="58" rx="8" fill="#2B2B33"/>
        <rect x="132" y="138" width="36" height="62" rx="8" fill="${accent}"/></g>`;
    case 'cup':
      return `<path d="M104 104h92l-10 104a12 12 0 0 1-12 10h-48a12 12 0 0 1-12-10z" fill="${accent}"/>
        <rect x="98" y="92" width="104" height="16" rx="8" fill="#2B2B33" opacity="0.7"/>`;
    case 'umbrella':
      return `<path d="M70 132a80 80 0 0 1 160 0z" fill="${accent}"/>
        <path d="M150 132v74a16 16 0 0 0 30 8" fill="none" stroke="${accent}" stroke-width="8"/>`;
    case 'candle':
      return `<rect x="104" y="120" width="92" height="92" rx="10" fill="${accent}"/>
        <rect x="146" y="88" width="8" height="34" fill="#2B2B33"/>
        <path d="M150 72c8 10 0 18 0 18s-9-8 0-18z" fill="#FF6B6B"/>`;
    default:
      return '';
  }
}

export function writeProductImages(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [key, s] of Object.entries(SPECS)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="240" viewBox="0 0 300 240">
  <rect width="300" height="240" rx="14" fill="${s.bg}"/>
  ${figure(s.shape, s.accent)}
  <text x="150" y="222" fill="#2B2B33" font-family="sans-serif" font-size="18" font-weight="600" text-anchor="middle">${s.label}</text>
</svg>`;
    writeFileSync(`${dir}/${key}.svg`, svg, 'utf8');
  }
}
