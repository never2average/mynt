import type { ActionId, ActionImpl } from 'kbar';
import * as React from 'react';
import { Kbd } from './ui';
import { cn } from '@/lib/utils';
import { BROWSE_IDS } from './actions';

const ResultItem = React.forwardRef(
  (
    {
      action,
      active,
      currentRootActionId
    }: {
      action: Pick<ActionImpl, 'id' | 'name' | 'subtitle' | 'icon' | 'shortcut' | 'ancestors'>;
      active: boolean;
      currentRootActionId: ActionId;
    },
    ref: React.Ref<HTMLDivElement>
  ) => {
    // A browse entry ("Members", "Audit actions") is already the section header: what's found under it reads on its own.
    const ancestors = React.useMemo(() => {
      const shown = action.ancestors.filter((ancestor) => !BROWSE_IDS.has(ancestor.id));
      if (!currentRootActionId) return shown;
      const index = shown.findIndex((ancestor) => ancestor.id === currentRootActionId);
      return shown.slice(index + 1);
    }, [action.ancestors, currentRootActionId]);

    return (
      <div
        ref={ref}
        className={cn(
          'relative mx-1.5 flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-2.5 text-sm',
          active && 'bg-accent text-accent-foreground'
        )}
      >
        <div className='flex items-center gap-2'>
          {action.icon}
          <div className='flex flex-col'>
            <div>
              {ancestors.length > 0 &&
                ancestors.map((ancestor) => (
                  <React.Fragment key={ancestor.id}>
                    <span className='text-muted-foreground mr-2'>{ancestor.name}</span>
                    <span className='mr-2'>&rsaquo;</span>
                  </React.Fragment>
                ))}
              <span>{action.name}</span>
            </div>
            {action.subtitle && (
              <span className='text-muted-foreground text-xs'>{action.subtitle}</span>
            )}
          </div>
        </div>
        {action.shortcut?.length ? (
          <div className='grid grid-flow-col gap-1'>
            {action.shortcut.map((sc, i) => (
              <Kbd key={sc + i}>{sc}</Kbd>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
);

ResultItem.displayName = 'KBarResultItem';

export default ResultItem;
