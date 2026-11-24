declare global {
  interface Window {
    api: {
      backendUrl: string
      apiToken: string
      downloadFile: (
        url: string,
        defaultName: string,
        onProgress?: (pct: number) => void
      ) => Promise<{ canceled?: boolean; filePath?: string; bytes?: number; error?: string }>
      pickEpubFile: () => Promise<{ canceled?: boolean; filePath?: string }>
    }
  }
}

export {}
