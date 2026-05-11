'use client'

/**
 * CategoryFilterContext
 *
 * Shared state for the category filter in the sidebar.
 * The sidebar sets which categories are selected; the dashboard
 * content reads it to filter what's shown.
 *
 * Default: all categories selected (no filter applied).
 * When the user deselects some, only those categories show in the grid and calendar.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

interface CategoryFilterContextType {
  /** Set of selected categoryIds. null = all selected (no filter). */
  selectedIds:   Set<string> | null
  /** Whether any filter is actually active (i.e. not all selected) */
  isFiltered:    boolean
  /** Check if a given categoryId passes the filter */
  isVisible:     (categoryId: string) => boolean
  /** Toggle a single category */
  toggle:        (categoryId: string, allIds: string[]) => void
  /** Select all */
  selectAll:     () => void
  /** Select only one */
  selectOnly:    (categoryId: string) => void
  /** Deselect all */
  selectNone:    (allIds: string[]) => void
}

const CategoryFilterContext = createContext<CategoryFilterContextType>({
  selectedIds:  null,
  isFiltered:   false,
  isVisible:    () => true,
  toggle:       () => {},
  selectAll:    () => {},
  selectOnly:   () => {},
  selectNone:   () => {},
})

export function CategoryFilterProvider({ children }: { children: ReactNode }) {
  // null = all selected
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null)

  const isFiltered = selectedIds !== null

  const isVisible = useCallback((categoryId: string) => {
    if (!selectedIds) return true
    return selectedIds.has(categoryId)
  }, [selectedIds])

  const toggle = useCallback((categoryId: string, allIds: string[]) => {
    setSelectedIds(prev => {
      // If currently "all selected", start a new set with everything except this one
      if (!prev) {
        const next = new Set(allIds)
        next.delete(categoryId)
        // If that results in all still selected, just return null
        return next.size === allIds.length ? null : next
      }
      const next = new Set(prev)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
        // If all are now selected, revert to null (no filter)
        if (next.size === allIds.length) return null
      }
      return next
    })
  }, [])

  const selectAll = useCallback(() => setSelectedIds(null), [])

  const selectOnly = useCallback((categoryId: string) => {
    setSelectedIds(new Set([categoryId]))
  }, [])

  const selectNone = useCallback((allIds: string[]) => {
    // "Select none" = empty set — show nothing
    setSelectedIds(new Set())
  }, [])

  return (
    <CategoryFilterContext.Provider value={{
      selectedIds,
      isFiltered,
      isVisible,
      toggle,
      selectAll,
      selectOnly,
      selectNone,
    }}>
      {children}
    </CategoryFilterContext.Provider>
  )
}

export function useCategoryFilter() {
  return useContext(CategoryFilterContext)
}
