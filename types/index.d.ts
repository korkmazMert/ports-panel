export type Port = {
  port: number
  label: string
  kind: 'docker' | 'native'
  isLan: boolean
  isWeb: boolean
}

export type Group = { id: string; name: string; isCurrent: boolean; ports: Port[] }

export type Snapshot = { groups: Group[]; tools: Port[]; isDockerUp: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ports-panel': {
      snapshot: Shaped<Snapshot | null>
      staleSince: number | null
      isToolsOpen: boolean
    }
  }
}
