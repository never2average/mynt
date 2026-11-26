'use client';
import { useKBar } from 'kbar';
import { IconSearch } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { Button, SEARCH_SCOPE } from './kbar/ui';

/** The header controls' one height, radius and border: the search box's 36px from tablet width up, a 44px icon button on a phone. */
export const TOP_BAR_CONTROL = 'h-11 min-w-11 rounded-[0.5rem] px-0 text-sm shadow-none md:h-9 md:min-w-9';

/** The top bar's search (Cmd+K): a box from tablet width up, an icon button on a phone. */
export default function SearchInput() {
  const { query } = useKBar();
  return (
    <span className={cn(SEARCH_SCOPE, 'contents')} data-search-input>
      <Button variant='outline' className={cn(TOP_BAR_CONTROL, 'md:hidden')} onClick={() => query?.toggle()} aria-label='Search' data-search-trigger>
        <IconSearch className='h-4 w-4' />
      </Button>
      <Button
        variant='outline'
        className={cn(
          TOP_BAR_CONTROL,
          'bg-background text-muted-foreground relative hidden justify-start font-normal sm:pr-12 md:flex md:w-40 md:px-3 lg:w-64'
        )}
        onClick={() => query?.toggle()}
        data-search-trigger
      >
        <IconSearch className='mr-2 h-4 w-4' />
        Search...
        <kbd className='bg-muted pointer-events-none absolute top-[0.3rem] right-[0.3rem] hidden h-6 items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100 select-none sm:flex'>
          <span className='text-xs'>⌘</span>K
        </kbd>
      </Button>
    </span>
  );
}
