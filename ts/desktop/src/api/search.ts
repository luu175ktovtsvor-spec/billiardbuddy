import { api } from './client'

type SearchResult = {
  file: string
  line: number
  text: string
  context?: string[]
}

type SearchResponse = { results: SearchResult[]; total: number }

export const searchApi = {
  search(params: { query: string; cwd?: string; maxResults?: number; glob?: string }) {
    return api.post<SearchResponse>('/api/search', params)
  },
}
