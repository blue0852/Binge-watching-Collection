interface Props {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}

export default function Pagination({ page, totalPages, onPageChange, disabled }: Props) {
  if (totalPages <= 1) return null;

  const pages = buildPageList(page, totalPages);

  return (
    <nav className="pagination" aria-label="分页">
      <button
        type="button"
        className="page-btn"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        上一页
      </button>
      <div className="page-numbers">
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`ellipsis-${i}`} className="page-ellipsis">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`page-num ${p === page ? 'active' : ''}`}
              disabled={disabled}
              onClick={() => onPageChange(p as number)}
            >
              {p}
            </button>
          ),
        )}
      </div>
      <button
        type="button"
        className="page-btn"
        disabled={disabled || page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </button>
      <span className="page-summary">
        第 {page} / {totalPages} 页
      </span>
    </nav>
  );
}

function buildPageList(current: number, total: number): (number | '…')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const list: (number | '…')[] = [1];
  if (current > 3) list.push('…');
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let p = start; p <= end; p++) list.push(p);
  if (current < total - 2) list.push('…');
  list.push(total);
  return list;
}
