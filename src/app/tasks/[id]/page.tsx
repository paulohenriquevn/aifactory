import { Link, useNavigate, useParams } from 'react-router'

import { TaskDetailView } from '../../components/TaskDetail'
import { useEscape } from '../../lib/keys'

/** A task on a page of its own: the link the inbox and a shared address use. */
export default function TaskPage() {
  const id = Number(useParams().id)
  const navigate = useNavigate()
  useEscape(() => void navigate('/work'))
  return (
    <TaskDetailView
      id={id}
      above={
        <Link to="/work" className="text-sm text-muted-foreground hover:text-foreground">
          ← Board
        </Link>
      }
    />
  )
}
