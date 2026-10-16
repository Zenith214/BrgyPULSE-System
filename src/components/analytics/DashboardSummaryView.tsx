'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp, TrendingDown, Minus, Users, Target, MapPin, Award } from 'lucide-react'
import { useActiveCycle } from '@/hooks/useSurveyCycle'
import { fetchWithCache } from '@/utils/analyticsCache'

const Line = dynamic(() => import('react-chartjs-2').then(mod => mod.Line), { ssr: false })
const Bar = dynamic(() => import('react-chartjs-2').then(mod => mod.Bar), { ssr: false })

if (typeof window !== 'undefined') {
  import('chart.js').then(({ Chart, CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler }) => {
    Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler)
  })
}

interface DashboardSummaryData {
  kpis: { overallSatisfaction: number; overallNeedForAction: number; totalResponses: number; targetResponses: number; barangaysCovered: number; totalBarangays: number }
  leaderboard: { top5: Array<{ barangayId: number; barangayName: string; satisfaction: number; trend: 'up' | 'down' | 'stable' }>; bottom5: Array<{ barangayId: number; barangayName: string; satisfaction: number; trend: 'up' | 'down' | 'stable' }> }
  trendData: Array<{ cycleName: string; cycleYear: number; avgSatisfaction: number }>
  serviceAreaPerformance: Array<{ serviceArea: string; avgSatisfaction: number }>
}

export default function DashboardSummaryView() {
  const { activeCycle, hasActiveCycle } = useActiveCycle()
  const [data, setData] = useState<DashboardSummaryData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (hasActiveCycle) fetchDashboardSummary() }, [hasActiveCycle, activeCycle])

  const fetchDashboardSummary = async () => {
    setLoading(true)
    try {
      const result = await fetchWithCache<DashboardSummaryData>('/api/analytics/dashboard-summary', { cycleId: activeCycle?.cycle_id }, { ttl: 5 * 60 * 1000 })
      setData(result)
    } catch (error) { console.error('Failed:', error) }
    finally { setLoading(false) }
  }

  if (loading) return <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div></div>
  if (!data) return <div className="text-center py-12 text-gray-500">No data available.</div>

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Overall Satisfaction</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold text-blue-600">{Number(data.kpis.overallSatisfaction).toFixed(1)}%</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Need for Action</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold text-orange-600">{Number(data.kpis.overallNeedForAction).toFixed(1)}%</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Responses</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold">{data.kpis.totalResponses}/{data.kpis.targetResponses}</div></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="text-sm">Barangays</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold">{data.kpis.barangaysCovered}/{data.kpis.totalBarangays}</div></CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>Leaderboard</CardTitle></CardHeader><CardContent><div className="grid grid-cols-2 gap-4"><div>{data.leaderboard.top5.map((b,i)=><div key={i} className="p-2 bg-green-50 rounded mb-1">{b.barangayName}: {Number(b.satisfaction).toFixed(1)}%</div>)}</div><div>{data.leaderboard.bottom5.map((b,i)=><div key={i} className="p-2 bg-red-50 rounded mb-1">{b.barangayName}: {Number(b.satisfaction).toFixed(1)}%</div>)}</div></div></CardContent></Card>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card><CardHeader><CardTitle>Trend</CardTitle></CardHeader><CardContent>{data.trendData.length===0?<div className="h-64 flex items-center justify-center">No data</div>:<Line data={{labels:data.trendData.map(d=>d.cycleName),datasets:[{label:'Satisfaction %',data:data.trendData.map(d=>d.avgSatisfaction),borderColor:'rgb(59,130,246)',backgroundColor:'rgba(59,130,246,0.1)',fill:true}]}} options={{responsive:true,plugins:{legend:{display:false}}}}/>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Service Areas</CardTitle></CardHeader><CardContent><Bar data={{labels:data.serviceAreaPerformance.map(s=>s.serviceArea),datasets:[{label:'Satisfaction %',data:data.serviceAreaPerformance.map(s=>s.avgSatisfaction),backgroundColor:'rgba(59,130,246,0.8)'}]}} options={{indexAxis:'y',responsive:true,plugins:{legend:{display:false}}}}/></CardContent></Card>
      </div>
    </div>
  )
}
