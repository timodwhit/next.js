import type { RouteMetadata } from '../../../export/routes/types'
import type { CacheHandler, CacheHandlerContext, CacheHandlerValue } from './'
import type { CacheFs } from '../../../shared/lib/utils'
import {
  CachedRouteKind,
  IncrementalCacheKind,
  type CachedFetchValue,
} from '../../response-cache'

import LRUCache from 'next/dist/compiled/lru-cache'
import path from '../../../shared/lib/isomorphic/path'
import {
  NEXT_CACHE_TAGS_HEADER,
  NEXT_DATA_SUFFIX,
  NEXT_META_SUFFIX,
  RSC_PREFETCH_SUFFIX,
  RSC_SUFFIX,
} from '../../../lib/constants'

type FileSystemCacheContext = Omit<
  CacheHandlerContext,
  'fs' | 'serverDistDir'
> & {
  fs: CacheFs
  serverDistDir: string
}

type TagsManifest = {
  version: 1
  items: { [tag: string]: { revalidatedAt: number } }
}
let memoryCache: LRUCache<string, CacheHandlerValue> | undefined
let tagsManifest: TagsManifest | undefined

export default class FileSystemCache implements CacheHandler {
  private fs: FileSystemCacheContext['fs']
  private flushToDisk?: FileSystemCacheContext['flushToDisk']
  private serverDistDir: FileSystemCacheContext['serverDistDir']
  private tagsManifestPath?: string
  private revalidatedTags: string[]
  private debug: boolean

  constructor(ctx: FileSystemCacheContext) {
    this.fs = ctx.fs
    this.flushToDisk = ctx.flushToDisk
    this.serverDistDir = ctx.serverDistDir
    this.revalidatedTags = ctx.revalidatedTags
    this.debug = !!process.env.NEXT_PRIVATE_DEBUG_CACHE

    if (ctx.maxMemoryCacheSize) {
      if (!memoryCache) {
        if (this.debug) {
          console.log('using memory store for fetch cache')
        }

        memoryCache = new LRUCache({
          max: ctx.maxMemoryCacheSize,
          length({ value }) {
            if (!value) {
              return 25
            } else if (value.kind === CachedRouteKind.REDIRECT) {
              return JSON.stringify(value.props).length
            } else if (value.kind === CachedRouteKind.IMAGE) {
              throw new Error('invariant image should not be incremental-cache')
            } else if (value.kind === CachedRouteKind.FETCH) {
              return JSON.stringify(value.data || '').length
            } else if (value.kind === CachedRouteKind.APP_ROUTE) {
              return value.body.length
            }
            // rough estimate of size of cache value
            return (
              value.html.length +
              (JSON.stringify(
                value.kind === CachedRouteKind.APP_PAGE
                  ? value.rscData
                  : value.pageData
              )?.length || 0)
            )
          },
        })
      }
    } else if (this.debug) {
      console.log('not using memory store for fetch cache')
    }

    if (this.serverDistDir && this.fs) {
      this.tagsManifestPath = path.join(
        this.serverDistDir,
        '..',
        'cache',
        'fetch-cache',
        'tags-manifest.json'
      )

      this.loadTagsManifestSync()
    }
  }

  public resetRequestCache(): void {}

  /**
   * Load the tags manifest from the file system
   */
  private async loadTagsManifest() {
    if (!this.tagsManifestPath || !this.fs || tagsManifest) return
    try {
      tagsManifest = JSON.parse(
        await this.fs.readFile(this.tagsManifestPath, 'utf8')
      )
    } catch (err: any) {
      tagsManifest = { version: 1, items: {} }
    }
    if (this.debug) console.log('loadTagsManifest', tagsManifest)
  }

  /**
   * As above, but synchronous for use in the constructor. This is to
   * preserve the existing behaviour when instantiating the cache handler. Although it's
   * not ideal to block the main thread it's only called once during startup.
   */
  private loadTagsManifestSync() {
    if (!this.tagsManifestPath || !this.fs || tagsManifest) return
    try {
      tagsManifest = JSON.parse(
        this.fs.readFileSync(this.tagsManifestPath, 'utf8')
      )
    } catch (err: any) {
      tagsManifest = { version: 1, items: {} }
    }
    if (this.debug) console.log('loadTagsManifest', tagsManifest)
  }

  public async revalidateTag(
    ...args: Parameters<CacheHandler['revalidateTag']>
  ) {
    let [tags] = args
    tags = typeof tags === 'string' ? [tags] : tags

    if (this.debug) {
      console.log('revalidateTag', tags)
    }

    if (tags.length === 0) {
      return
    }

    // we need to ensure the tagsManifest is refreshed
    // since separate workers can be updating it at the same
    // time and we can't flush out of sync data
    await this.loadTagsManifest()
    if (!tagsManifest || !this.tagsManifestPath) {
      return
    }

    for (const tag of tags) {
      const data = tagsManifest.items[tag] || {}
      data.revalidatedAt = Date.now()
      tagsManifest.items[tag] = data
    }

    try {
      await this.fs.mkdir(path.dirname(this.tagsManifestPath))
      await this.fs.writeFile(
        this.tagsManifestPath,
        JSON.stringify(tagsManifest || {})
      )
      if (this.debug) {
        console.log('Updated tags manifest', tagsManifest)
      }
    } catch (err: any) {
      console.warn('Failed to update tags manifest.', err)
    }
  }

  public async get(...args: Parameters<CacheHandler['get']>) {
    const [key, ctx] = args
    const { tags, softTags, kind, isRoutePPREnabled, isFallback } = ctx

    let data = memoryCache?.get(key)

    if (this.debug) {
      console.log('get', key, tags, kind, !!data)
    }

    // let's check the disk for seed data
    if (!data && process.env.NEXT_RUNTIME !== 'edge') {
      if (kind === IncrementalCacheKind.APP_ROUTE) {
        try {
          const filePath = this.getFilePath(
            `${key}.body`,
            IncrementalCacheKind.APP_ROUTE
          )
          const fileData = await this.fs.readFile(filePath)
          const { mtime } = await this.fs.stat(filePath)

          const meta = JSON.parse(
            await this.fs.readFile(
              filePath.replace(/\.body$/, NEXT_META_SUFFIX),
              'utf8'
            )
          )

          const cacheEntry: CacheHandlerValue = {
            lastModified: mtime.getTime(),
            value: {
              kind: CachedRouteKind.APP_ROUTE,
              body: fileData,
              headers: meta.headers,
              status: meta.status,
            },
          }
          return cacheEntry
        } catch {
          return null
        }
      }

      try {
        const filePath = this.getFilePath(
          kind === IncrementalCacheKind.FETCH ? key : `${key}.html`,
          kind
        )

        const fileData = await this.fs.readFile(filePath, 'utf8')
        const { mtime } = await this.fs.stat(filePath)

        if (kind === IncrementalCacheKind.FETCH) {
          if (!this.flushToDisk) return null

          const lastModified = mtime.getTime()
          const parsedData: CachedFetchValue = JSON.parse(fileData)
          data = {
            lastModified,
            value: parsedData,
          }

          if (data.value?.kind === CachedRouteKind.FETCH) {
            const storedTags = data.value?.tags

            // update stored tags if a new one is being added
            // TODO: remove this when we can send the tags
            // via header on GET same as SET
            if (!tags?.every((tag) => storedTags?.includes(tag))) {
              if (this.debug) {
                console.log('tags vs storedTags mismatch', tags, storedTags)
              }
              await this.set(key, data.value, {
                tags,
                isRoutePPREnabled,
              })
            }
          }
        } else if (kind === IncrementalCacheKind.APP_PAGE) {
          let meta: RouteMetadata | undefined
          let rscData: Buffer | undefined

          // We try to load the metadata file, but if it fails, we don't
          // error. We also don't load it if this is a fallback.
          if (!isFallback) {
            try {
              meta = JSON.parse(
                await this.fs.readFile(
                  filePath.replace(/\.html$/, NEXT_META_SUFFIX),
                  'utf8'
                )
              )
            } catch {}

            rscData = await this.fs.readFile(
              this.getFilePath(
                `${key}${isRoutePPREnabled ? RSC_PREFETCH_SUFFIX : RSC_SUFFIX}`,
                IncrementalCacheKind.APP_PAGE
              )
            )
          }

          data = {
            lastModified: mtime.getTime(),
            value: {
              kind: CachedRouteKind.APP_PAGE,
              html: fileData,
              rscData,
              postponed: meta?.postponed,
              headers: meta?.headers,
              status: meta?.status,
            },
          }
        } else if (kind === IncrementalCacheKind.PAGES) {
          let meta: RouteMetadata | undefined
          let pageData: string | object = {}

          if (!isFallback) {
            pageData = JSON.parse(
              await this.fs.readFile(
                this.getFilePath(
                  `${key}${NEXT_DATA_SUFFIX}`,
                  IncrementalCacheKind.PAGES
                ),
                'utf8'
              )
            )
          }

          data = {
            lastModified: mtime.getTime(),
            value: {
              kind: CachedRouteKind.PAGES,
              html: fileData,
              pageData,
              headers: meta?.headers,
              status: meta?.status,
            },
          }
        } else {
          throw new Error(
            `Invariant: Unexpected route kind ${kind} in file system cache.`
          )
        }

        if (data) {
          memoryCache?.set(key, data)
        }
      } catch {
        return null
      }
    }

    if (
      data?.value?.kind === CachedRouteKind.APP_PAGE ||
      data?.value?.kind === CachedRouteKind.PAGES
    ) {
      let cacheTags: undefined | string[]
      const tagsHeader = data.value.headers?.[NEXT_CACHE_TAGS_HEADER]

      if (typeof tagsHeader === 'string') {
        cacheTags = tagsHeader.split(',')
      }

      if (cacheTags?.length) {
        await this.loadTagsManifest()

        const isStale = cacheTags.some((tag) => {
          return (
            tagsManifest?.items[tag]?.revalidatedAt &&
            tagsManifest?.items[tag].revalidatedAt >=
              (data?.lastModified || Date.now())
          )
        })

        // we trigger a blocking validation if an ISR page
        // had a tag revalidated, if we want to be a background
        // revalidation instead we return data.lastModified = -1
        if (isStale) {
          return null
        }
      }
    } else if (data?.value?.kind === CachedRouteKind.FETCH) {
      await this.loadTagsManifest()

      const combinedTags = [...(tags || []), ...(softTags || [])]

      const wasRevalidated = combinedTags.some((tag) => {
        if (this.revalidatedTags.includes(tag)) {
          return true
        }

        return (
          tagsManifest?.items[tag]?.revalidatedAt &&
          tagsManifest?.items[tag].revalidatedAt >=
            (data?.lastModified || Date.now())
        )
      })
      // When revalidate tag is called we don't return
      // stale data so it's updated right away
      if (wasRevalidated) {
        data = undefined
      }
    }

    return data ?? null
  }

  public async set(...args: Parameters<CacheHandler['set']>) {
    const [key, data, ctx] = args
    const { isFallback } = ctx
    memoryCache?.set(key, {
      value: data,
      lastModified: Date.now(),
    })

    if (this.debug) {
      console.log('set', key)
    }

    if (!this.flushToDisk || !data) return

    if (data.kind === CachedRouteKind.APP_ROUTE) {
      const filePath = this.getFilePath(
        `${key}.body`,
        IncrementalCacheKind.APP_ROUTE
      )
      await this.fs.mkdir(path.dirname(filePath))
      await this.fs.writeFile(filePath, data.body)

      const meta: RouteMetadata = {
        headers: data.headers,
        status: data.status,
        postponed: undefined,
      }

      await this.fs.writeFile(
        filePath.replace(/\.body$/, NEXT_META_SUFFIX),
        JSON.stringify(meta, null, 2)
      )
    } else if (
      data.kind === CachedRouteKind.PAGES ||
      data.kind === CachedRouteKind.APP_PAGE
    ) {
      const isAppPath = data.kind === CachedRouteKind.APP_PAGE
      const htmlPath = this.getFilePath(
        `${key}.html`,
        isAppPath ? IncrementalCacheKind.APP_PAGE : IncrementalCacheKind.PAGES
      )
      await this.fs.mkdir(path.dirname(htmlPath))
      await this.fs.writeFile(htmlPath, data.html)

      // Fallbacks don't generate a data file.
      if (!isFallback) {
        await this.fs.writeFile(
          this.getFilePath(
            `${key}${
              isAppPath
                ? ctx.isRoutePPREnabled
                  ? RSC_PREFETCH_SUFFIX
                  : RSC_SUFFIX
                : NEXT_DATA_SUFFIX
            }`,
            isAppPath
              ? IncrementalCacheKind.APP_PAGE
              : IncrementalCacheKind.PAGES
          ),
          isAppPath ? data.rscData : JSON.stringify(data.pageData)
        )
      }

      if (data?.kind === CachedRouteKind.APP_PAGE) {
        const meta: RouteMetadata = {
          headers: data.headers,
          status: data.status,
          postponed: data.postponed,
        }

        await this.fs.writeFile(
          htmlPath.replace(/\.html$/, NEXT_META_SUFFIX),
          JSON.stringify(meta)
        )
      }
    } else if (data.kind === CachedRouteKind.FETCH) {
      const filePath = this.getFilePath(key, IncrementalCacheKind.FETCH)
      await this.fs.mkdir(path.dirname(filePath))
      await this.fs.writeFile(
        filePath,
        JSON.stringify({
          ...data,
          tags: ctx.tags,
        })
      )
    } else {
      throw new Error(
        `Invariant: Unexpected route kind ${data.kind} in file system cache.`
      )
    }
  }

  private getFilePath(pathname: string, kind: IncrementalCacheKind): string {
    switch (kind) {
      case IncrementalCacheKind.FETCH:
        // we store in .next/cache/fetch-cache so it can be persisted
        // across deploys
        return path.join(
          this.serverDistDir,
          '..',
          'cache',
          'fetch-cache',
          pathname
        )
      case IncrementalCacheKind.PAGES:
        return path.join(this.serverDistDir, 'pages', pathname)
      case IncrementalCacheKind.IMAGE:
      case IncrementalCacheKind.APP_PAGE:
      case IncrementalCacheKind.APP_ROUTE:
        return path.join(this.serverDistDir, 'app', pathname)
      default:
        throw new Error(`Unexpected file path kind: ${kind}`)
    }
  }
}
