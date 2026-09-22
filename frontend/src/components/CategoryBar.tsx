import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchCategories } from '../api/client.js';
import type { VodCategory } from '../types.js';

interface Props {
  source: string;
}

export default function CategoryBar({ source }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [categories, setCategories] = useState<VodCategory[]>([]);

  const params = new URLSearchParams(location.search);
  const selectedType = Number(params.get('type')) || 0;

  useEffect(() => {
    let cancelled = false;
    if (source === 'archive') {
      setCategories([]);
      return;
    }
    fetchCategories(source)
      .then((res) => {
        if (!cancelled) setCategories(res.categories);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const roots = useMemo(
    () => categories.filter((c) => (c.typePid ?? 0) === 0),
    [categories],
  );

  const activeParent = useMemo(() => {
    if (!selectedType) return null;
    const asRoot = roots.find((r) => r.typeId === selectedType);
    if (asRoot) return asRoot;
    return (
      roots.find((r) =>
        categories.some((c) => c.typePid === r.typeId && c.typeId === selectedType),
      ) ?? null
    );
  }, [selectedType, roots, categories]);

  const subCategories = useMemo(() => {
    if (!activeParent) return [];
    return categories.filter((c) => (c.typePid ?? 0) === activeParent.typeId);
  }, [activeParent, categories]);

  if (source === 'archive' || categories.length === 0) return null;

  function navigateWithType(typeId: number) {
    const next = new URLSearchParams(location.search);
    next.delete('page');
    if (typeId) next.set('type', String(typeId));
    else next.delete('type');
    const qs = next.toString();
    navigate(qs ? `/?${qs}` : '/');
  }

  return (
    <nav className="category-bar" aria-label="分类筛选">
      <div className="category-row">
        <button
          type="button"
          className={`category-tag ${selectedType === 0 ? 'active' : ''}`}
          onClick={() => navigateWithType(0)}
        >
          全部
        </button>
        {roots.map((cat) => (
          <button
            key={cat.typeId}
            type="button"
            className={`category-tag ${
              selectedType === cat.typeId || activeParent?.typeId === cat.typeId
                ? 'active'
                : ''
            }`}
            onClick={() => navigateWithType(cat.typeId)}
          >
            {cat.typeName}
          </button>
        ))}
      </div>
      {subCategories.length > 0 && (
        <div className="category-row category-sub">
          {subCategories.map((cat) => (
            <button
              key={cat.typeId}
              type="button"
              className={`category-tag ${selectedType === cat.typeId ? 'active' : ''}`}
              onClick={() => navigateWithType(cat.typeId)}
            >
              {cat.typeName}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}
